// @flow

import type Database, {BindingDictionary, Statement} from "better-sqlite3";
import stringify from "json-stable-stringify";

import dedent from "../util/dedent";
import * as MapUtil from "../util/map";
import * as NullUtil from "../util/null";
import * as Schema from "./schema";
import * as Queries from "./queries";

/**
 * A local mirror of a subset of a GraphQL database.
 *
 * Clients should interact with this module as follows:
 *
 *   - Invoke the constructor to acquire a `Mirror` instance.
 *   - Invoke `registerObject` to register a root object of interest.
 *   - Invoke `update` to update all transitive dependencies.
 *   - Invoke `extract` to retrieve the data in structured form.
 *
 * See the relevant methods for documentation.
 */
/*
 * NOTE(perf): The implementation of this class is not particularly
 * optimized. In particular, when we interact with SQLite, we compile
 * our prepared statements many times over the lifespan of an
 * instance. It may be beneficial to precompile them at instance
 * construction time.
 */
export class Mirror {
  +_db: Database;
  +_schema: Schema.Schema;
  +_schemaInfo: SchemaInfo;
  +_blacklistedIds: {|+[Schema.ObjectId]: true|};

  /**
   * Create a GraphQL mirror using the given database connection and
   * GraphQL schema.
   *
   * The connection must be to a database that either (a) is empty and
   * unused, or (b) has been previously used for a GraphQL mirror with
   * an identical GraphQL schema and options. The database attached to
   * the connection must not be modified by any other clients. In other
   * words, passing a connection to this constructor entails
   * transferring ownership of the attached database to this module.
   *
   * If the database attached to the connection has been used with an
   * incompatible GraphQL schema or an outdated version of this module,
   * an error will be thrown and the database will remain unmodified.
   *
   * If a list of blacklisted IDs is provided, then any object with
   * matching ID will be treated as `null` when it appears as the target
   * of a node reference, nested node reference, or connection entry.
   * This can be used to work around bugs in remote schemas.
   */
  constructor(
    db: Database,
    schema: Schema.Schema,
    options?: {|+blacklistedIds?: $ReadOnlyArray<Schema.ObjectId>|}
  ): void {
    if (db == null) throw new Error("db: " + String(db));
    if (schema == null) throw new Error("schema: " + String(schema));
    const fullOptions = {
      ...{blacklistedIds: []},
      ...(options || {}),
    };
    this._db = db;
    this._schema = schema;
    this._schemaInfo = _buildSchemaInfo(this._schema);
    this._blacklistedIds = (() => {
      const result: {|[Schema.ObjectId]: true|} = ({}: any);
      for (const id of fullOptions.blacklistedIds) {
        result[id] = true;
      }
      return result;
    })();
    this._initialize();
  }

  /**
   * Embed the GraphQL schema into the database, initializing it for use
   * as a mirror.
   *
   * This method should only be invoked once, at construction time.
   *
   * If the database has already been initialized with the same schema
   * and version, no action is taken and no error is thrown. If the
   * database has been initialized with a different schema or version,
   * the database is left unchanged, and an error is thrown.
   *
   * A discussion of the database structure follows.
   *
   * ---
   *
   * Objects have three kinds of fields: connections, links, and
   * primitives (plus an ID, which we ignore for now). The database has
   * a single `connections` table for all objects, and also a single
   * `links` table for all objects. For primitives, each GraphQL data
   * type has its own table, and each object of that type has a row in
   * the corresponding table.
   *
   * In more detail:
   *
   *   - The `connections` table has a row for each `(id, fieldname)`
   *     pair, where `fieldname` is the name of a connection field on the
   *     object with the given ID. This stores metadata about the
   *     connection: its total count, when it was last updated, etc. It
   *     does not store the actual entries in the connection (the nodes
   *     that the connection points to); `connection_entries` stores
   *     these.
   *
   *   - The `links` table has a row for each `(id, fieldname)` pair,
   *     where `fieldname` is the name of a link field on the object
   *     with the given ID. This simply points to the referenced object.
   *
   *   - For each type `T`, the `primitives_T` table has one row for
   *     each object of type `T`, storing the primitive data of the
   *     object.
   *
   *     All values are stored as stringified JSON values: so, for
   *     instance, the JSON value `null` is represented as the SQL
   *     string 'null', _not_ SQL NULL, while the JSON string "null" is
   *     represented as the SQL string '"null"'. This is primarily to
   *     accommodate storing booleans: SQLite encodes `true` and `false`
   *     as `1` and `0`, but we need to be able to distinguish between
   *     these respective values. There are other ways to do this more
   *     efficiently in both space and time (see discussion on #883 for
   *     some options).
   *
   * We refer to node and primitive data together as "own data", because
   * this is the data that can be queried uniformly for all elements of
   * a type; querying connection data, by contrast, requires the
   * object-specific end cursor.
   *
   * Nested fields merit additional explanation. The nested field itself
   * exists on the primitives table with SQL value either NULL, 0, or 1
   * (as SQL integers, not strings). As with all other primitives,
   * `NULL` indicates that the value has never been fetched. If the
   * value has been fetched, it is 0 if the nested field itself was
   * `null` on the GraphQL result, or 1 if it was present. This field
   * lets us distinguish "author: null" from "author: {user: null}".
   *
   * The "eggs" of a nested field are treated as normal primitive or
   * link values, whose fieldname is the nested fieldname and egg
   * fieldname joined by a period. So, if object type `Foo` has nested
   * field `bar: Schema.nested({baz: Schema.primitive()})`, then the
   * `primitives_Foo` table will include a column "bar.baz". Likewise, a
   * row in the `links` table might have fieldname 'quux.zod'.
   *
   * All aforementioned tables are keyed by object ID. Each object also
   * appears once in the `objects` table, which relates its ID,
   * typename, and last own-data update. Each connection has its own
   * last-update value, because connections can be updated independently
   * of each other and of own-data.
   *
   * Note that any object in the database should have entries in the
   * `connections` and `links` table for all relevant fields, as well as
   * an entry in the relevant primitives table, even if the node has
   * never been updated. This is for convenience of implementation: it
   * means that the first fetch for a node is the same as subsequent
   * fetches (a SQL `UPDATE` instead of first requiring an existence
   * check).
   *
   * Finally, a table `meta` is used to store metadata about the mirror
   * itself. This is used to make sure that the mirror is not loaded
   * with an incompatible version of the code or schema. It is never
   * updated after it is first set.
   */
  _initialize() {
    // The following version number must be updated if there is any
    // change to the way in which a GraphQL schema is mapped to a SQL
    // schema or the way in which the resulting SQL schema is
    // interpreted. If you've made a change and you're not sure whether
    // it requires bumping the version, bump it: requiring some extra
    // one-time cache resets is okay; doing the wrong thing is not.
    const blob = stringify({
      version: "MIRROR_v3",
      schema: this._schema,
      options: {
        blacklistedIds: this._blacklistedIds,
      },
    });
    const db = this._db;
    _inTransaction(db, () => {
      // We store the metadata in a singleton table `meta`, whose unique row
      // has primary key `0`. Only the first ever insert will succeed; we
      // are locked into the first config.
      db.prepare(
        dedent`\
          CREATE TABLE IF NOT EXISTS meta (
              zero INTEGER PRIMARY KEY,
              config TEXT NOT NULL
          )
        `
      ).run();

      const existingBlob: string | void = db
        .prepare("SELECT config FROM meta")
        .pluck()
        .get();
      if (existingBlob === blob) {
        // Already set up; nothing to do.
        return;
      } else if (existingBlob !== undefined) {
        throw new Error(
          "Database already populated with " +
            "incompatible schema, options, or version"
        );
      }
      db.prepare("INSERT INTO meta (zero, config) VALUES (0, ?)").run(blob);

      // First, create those tables that are independent of the schema.
      const structuralTables = [
        // Time is stored in milliseconds since 1970-01-01T00:00Z, with
        // ECMAScript semantics (leap seconds ignored, exactly 86.4M ms
        // per day, etc.).
        //
        // We use milliseconds rather than seconds because (a) this
        // simplifies JavaScript interop to a simple `+new Date()` and
        // `new Date(value)`, and (b) this avoids a lurking Year 2038
        // problem by surfacing >32-bit values immediately. (We have
        // over 200,000 years before the number of milliseconds since
        // epoch is more than `Number.MAX_SAFE_INTEGER`.)
        dedent`\
          CREATE TABLE updates (
              rowid INTEGER PRIMARY KEY,
              time_epoch_millis INTEGER NOT NULL
          )
        `,
        dedent`\
          CREATE TABLE objects (
              id TEXT NOT NULL PRIMARY KEY,
              typename TEXT NOT NULL,
              last_update INTEGER,
              FOREIGN KEY(last_update) REFERENCES updates(rowid)
          )
        `,
        dedent`\
          CREATE TABLE links (
              rowid INTEGER PRIMARY KEY,
              parent_id TEXT NOT NULL,
              fieldname TEXT NOT NULL,
              child_id TEXT,
              UNIQUE(parent_id, fieldname),
              FOREIGN KEY(parent_id) REFERENCES objects(id),
              FOREIGN KEY(child_id) REFERENCES objects(id)
          )
        `,
        dedent`\
          CREATE UNIQUE INDEX idx_links__parent_id__fieldname
          ON links (parent_id, fieldname)
        `,
        dedent`\
          CREATE TABLE connections (
              rowid INTEGER PRIMARY KEY,
              object_id TEXT NOT NULL,
              fieldname TEXT NOT NULL,
              last_update INTEGER,
              -- Each of the below fields must be NULL if the connection
              -- has never been updated.
              total_count INTEGER,
              has_next_page BOOLEAN,
              -- The end cursor may be NULL if no items are in the connection;
              -- this is a consequence of GraphQL and the Relay pagination spec.
              -- (It may also be NULL if the connection was never updated.)
              end_cursor TEXT,
              CHECK((last_update IS NULL) = (total_count IS NULL)),
              CHECK((last_update IS NULL) = (has_next_page IS NULL)),
              CHECK((last_update IS NULL) <= (end_cursor IS NULL)),
              UNIQUE(object_id, fieldname),
              FOREIGN KEY(object_id) REFERENCES objects(id),
              FOREIGN KEY(last_update) REFERENCES updates(rowid)
          )
        `,
        dedent`\
          CREATE UNIQUE INDEX idx_connections__object_id__fieldname
          ON connections (object_id, fieldname)
        `,
        dedent`\
          CREATE TABLE connection_entries (
              rowid INTEGER PRIMARY KEY,
              connection_id INTEGER NOT NULL,
              idx INTEGER NOT NULL,  -- impose an ordering
              child_id TEXT,
              UNIQUE(connection_id, idx),
              FOREIGN KEY(connection_id) REFERENCES connections(rowid),
              FOREIGN KEY(child_id) REFERENCES objects(id)
          )
        `,
        dedent`\
          CREATE INDEX idx_connection_entries__connection_id
          ON connection_entries (connection_id)
        `,
      ];
      for (const sql of structuralTables) {
        db.prepare(sql).run();
      }

      // Then, create primitive-data tables, which depend on the schema.
      // We only create tables for object types, as union types have no
      // physical representation; they exist only at the type level.
      for (const typename of Object.keys(this._schemaInfo.objectTypes)) {
        const type = this._schemaInfo.objectTypes[typename];
        if (!isSqlSafe(typename)) {
          throw new Error(
            "invalid object type name: " + JSON.stringify(typename)
          );
        }
        for (const fieldname of type.primitiveFieldNames) {
          if (!isSqlSafe(fieldname)) {
            throw new Error("invalid field name: " + JSON.stringify(fieldname));
          }
        }
        for (const fieldname of type.nestedFieldNames) {
          if (!isSqlSafe(fieldname)) {
            throw new Error("invalid field name: " + JSON.stringify(fieldname));
          }
          const children = type.nestedFields[fieldname].primitives;
          for (const childFieldname of Object.keys(children)) {
            if (!isSqlSafe(childFieldname)) {
              throw new Error(
                "invalid field name: " +
                  JSON.stringify(childFieldname) +
                  " under " +
                  JSON.stringify(fieldname)
              );
            }
          }
        }
        const tableName = _primitivesTableName(typename);
        const tableSpec = []
          .concat(
            ["id TEXT NOT NULL PRIMARY KEY"],
            type.primitiveFieldNames.map((fieldname) => `"${fieldname}"`),
            type.nestedFieldNames.map((fieldname) => `"${fieldname}"`),
            ...type.nestedFieldNames.map((f1) =>
              Object.keys(type.nestedFields[f1].primitives).map(
                (f2) => `"${f1}.${f2}"`
              )
            ),
            ["FOREIGN KEY(id) REFERENCES objects(id)"]
          )
          .join(", ");
        db.prepare(`CREATE TABLE ${tableName} (${tableSpec})`).run();
      }
    });
  }

  /**
   * Register a new update, representing one communication with the
   * remote server. A unique ID will be created and returned.
   */
  _createUpdate(updateTimestamp: Date): UpdateId {
    return this._db
      .prepare("INSERT INTO updates (time_epoch_millis) VALUES (?)")
      .run(+updateTimestamp).lastInsertROWID;
  }

  /**
   * Inform the GraphQL mirror of the existence of an object. The
   * object's name and concrete type must be specified. The concrete
   * type must be an OBJECT type in the GraphQL schema.
   *
   * If the object has previously been registered with the same type, no
   * action is taken and no error is raised. If the object has
   * previously been registered with a different type, an error is
   * thrown, and the database is left unchanged.
   */
  registerObject(object: {|
    +typename: Schema.Typename,
    +id: Schema.ObjectId,
  |}): void {
    _inTransaction(this._db, () => {
      this._nontransactionallyRegisterObject(object);
    });
  }

  /**
   * As `registerObject`, but do not enter any transactions. Other
   * methods may call this method as a subroutine in a larger
   * transaction.
   */
  _nontransactionallyRegisterObject(object: {|
    +typename: Schema.Typename,
    +id: Schema.ObjectId,
  |}): void {
    const db = this._db;
    const {typename, id} = object;

    const existingTypename = db
      .prepare("SELECT typename FROM objects WHERE id = ?")
      .pluck()
      .get(id);
    if (existingTypename === typename) {
      // Already registered; nothing to do.
      return;
    } else if (existingTypename !== undefined) {
      const s = JSON.stringify;
      throw new Error(
        `Inconsistent type for ID ${s(id)}: ` +
          `expected ${s(existingTypename)}, got ${s(typename)}`
      );
    }

    if (this._schema[typename] == null) {
      throw new Error("Unknown type: " + JSON.stringify(typename));
    }
    if (this._schema[typename].type !== "OBJECT") {
      throw new Error(
        "Cannot add object of non-object type: " +
          `${JSON.stringify(typename)} (${this._schema[typename].type})`
      );
    }

    this._db
      .prepare(
        dedent`\
          INSERT INTO objects (id, last_update, typename)
          VALUES (:id, NULL, :typename)
        `
      )
      .run({id, typename});
    this._db
      .prepare(
        dedent`\
          INSERT INTO ${_primitivesTableName(typename)} (id)
          VALUES (?)
        `
      )
      .run(id);
    const addLink = this._db.prepare(
      dedent`\
        INSERT INTO links (parent_id, fieldname, child_id)
        VALUES (:id, :fieldname, NULL)
      `
    );
    const addConnection = this._db.prepare(
      // These fields are initialized to NULL because there has
      // been no update and so they have no meaningful values:
      // last_update, total_count, has_next_page, end_cursor.
      dedent`\
        INSERT INTO connections (object_id, fieldname)
        VALUES (:id, :fieldname)
      `
    );
    const objectType = this._schemaInfo.objectTypes[typename];
    for (const fieldname of objectType.linkFieldNames) {
      addLink.run({id, fieldname});
    }
    for (const parentFieldname of objectType.nestedFieldNames) {
      const children = objectType.nestedFields[parentFieldname].nodes;
      for (const childFieldname of Object.keys(children)) {
        const fieldname = `${parentFieldname}.${childFieldname}`;
        addLink.run({id, fieldname});
      }
    }
    for (const fieldname of objectType.connectionFieldNames) {
      addConnection.run({id, fieldname});
    }
  }

  /**
   * Register an object corresponding to the provided `NodeFieldResult`,
   * if any, returning the object's ID. If the provided value is `null`,
   * no action is taken, no error is thrown, and `null` is returned.
   *
   * As with `registerObject`, an error is thrown if an object by the
   * given ID already exists with a different typename.
   *
   * This method does not begin or end any transactions. Other methods
   * may call this method as a subroutine in a larger transaction.
   *
   * See: `registerObject`.
   */
  _nontransactionallyRegisterNodeFieldResult(
    result: NodeFieldResult
  ): Schema.ObjectId | null {
    if (result == null) {
      return null;
    } else if (this._blacklistedIds[result.id]) {
      return null;
    } else {
      const object = {typename: result.__typename, id: result.id};
      this._nontransactionallyRegisterObject(object);
      return object.id;
    }
  }

  /**
   * Find objects and connections that are not known to be up-to-date.
   *
   * An object is up-to-date if its own data has been loaded at least as
   * recently as the provided date.
   *
   * A connection is up-to-date if it has been fetched at least as
   * recently as the provided date, and at the time of fetching there
   * were no more pages.
   */
  _findOutdated(since: Date): QueryPlan {
    const db = this._db;
    return _inTransaction(db, () => {
      const objects: $PropertyType<QueryPlan, "objects"> = db
        .prepare(
          dedent`\
            SELECT typename AS typename, id AS id
            FROM objects
            LEFT OUTER JOIN updates ON objects.last_update = updates.rowid
            WHERE objects.last_update IS NULL
            OR updates.time_epoch_millis < :timeEpochMillisThreshold
          `
        )
        .all({timeEpochMillisThreshold: +since});
      const connections: $PropertyType<QueryPlan, "connections"> = db
        .prepare(
          dedent`\
            SELECT
                objects.typename AS objectTypename,
                connections.object_id AS objectId,
                connections.fieldname AS fieldname,
                connections.last_update IS NULL AS neverUpdated,
                connections.end_cursor AS endCursor
            FROM connections
            LEFT OUTER JOIN updates
                ON connections.last_update = updates.rowid
            JOIN objects
                ON connections.object_id = objects.id
            WHERE connections.has_next_page
            OR connections.last_update IS NULL
            OR updates.time_epoch_millis < :timeEpochMillisThreshold
          `
        )
        .all({timeEpochMillisThreshold: +since})
        .map((entry) => {
          const result = {...entry};
          if (result.neverUpdated) {
            result.endCursor = undefined; // as opposed to `null`
          }
          delete result.neverUpdated;
          return result;
        });
      const typenames: $PropertyType<QueryPlan, "typenames"> = [];
      return {objects, connections, typenames};
    });
  }

  /**
   * Create a GraphQL selection set to fetch data corresponding to the
   * given query plan.
   *
   * The resulting GraphQL should be embedded into a top-level query.
   *
   * The result of this query is an `UpdateResult`.
   *
   * This function is pure: it does not interact with the database.
   */
  _queryFromPlan(
    queryPlan: QueryPlan,
    options: {|
      // When fetching own-data for nodes of a given type, how many
      // nodes may we fetch at once?
      +nodesOfTypeLimit: number,
      // For how many nodes may we fetch own-data at once, across all
      // types?
      +nodesLimit: number,
      // How many connections may we fetch at top level?
      +connectionLimit: number,
      // When fetching entries in a connection, how many entities may we
      // request at once? (What is the `first` argument?)
      +connectionPageSize: number,
    |}
  ): Queries.Selection[] {
    if (queryPlan.typenames && queryPlan.typenames.length) {
      throw new Error("Unfaithful typenames not yet implemented");
    }
    // Group objects by type, so that we have to specify each type's
    // fieldset fewer times (only once per `nodesOfTypeLimit` nodes
    // instead of for every node).
    const objectsByType: Map<Schema.Typename, Schema.ObjectId[]> = new Map();
    for (const object of queryPlan.objects.slice(0, options.nodesLimit)) {
      MapUtil.pushValue(objectsByType, object.typename, object.id);
    }
    const paginatedObjectsByType: Array<{|
      +typename: Schema.Typename,
      +ids: $ReadOnlyArray<Schema.ObjectId>,
    |}> = [];
    for (const [typename, allIds] of objectsByType.entries()) {
      for (let i = 0; i < allIds.length; i += options.nodesOfTypeLimit) {
        const ids = allIds.slice(i, i + options.nodesOfTypeLimit);
        paginatedObjectsByType.push({typename, ids});
      }
    }

    // Group connections by object, so that we only have to fetch the
    // node once.
    const connectionsByObject: Map<
      Schema.ObjectId,
      {|
        +typename: Schema.Typename,
        +connections: Array<{|
          +fieldname: Schema.Fieldname,
          +endCursor: EndCursor | void,
        |}>,
      |}
    > = new Map();
    for (const connection of queryPlan.connections.slice(
      0,
      options.connectionLimit
    )) {
      let existing = connectionsByObject.get(connection.objectId);
      if (existing == null) {
        existing = {typename: connection.objectTypename, connections: []};
        connectionsByObject.set(connection.objectId, existing);
      } else {
        if (connection.objectTypename !== existing.typename) {
          const s = JSON.stringify;
          throw new Error(
            `Query plan has inconsistent typenames for ` +
              `object ${s(connection.objectId)}: ` +
              `${s(existing.typename)} vs. ${s(connection.objectTypename)}`
          );
        }
      }
      existing.connections.push({
        fieldname: connection.fieldname,
        endCursor: connection.endCursor,
      });
    }

    const b = Queries.build;

    // Each top-level field corresponds to either an object type
    // (fetching own data for objects of that type) or a particular node
    // (updating connections on that node). We alias each such field,
    // which is necessary to ensure that their names are all unique. The
    // names chosen are sufficient to identify which _kind_ of query the
    // field corresponds to (type's own data vs node's connections), but
    // do not need to identify the particular type or node in question.
    // This is because all descendant selections are self-describing:
    // they include the ID of any relevant objects.
    return [].concat(
      paginatedObjectsByType.map(({typename, ids}, i) => {
        const name = `${_FIELD_PREFIXES.OWN_DATA}${i}`;
        return b.alias(
          name,
          b.field("nodes", {ids: b.list(ids.map((id) => b.literal(id)))}, [
            b.inlineFragment(typename, this._queryOwnData(typename)),
          ])
        );
      }),
      Array.from(connectionsByObject.entries()).map(
        ([id, {typename, connections}], i) => {
          const name = `${_FIELD_PREFIXES.NODE_CONNECTIONS}${i}`;
          return b.alias(
            name,
            b.field("node", {id: b.literal(id)}, [
              b.field("id"),
              b.inlineFragment(
                typename,
                [].concat(
                  ...connections.map(({fieldname, endCursor}) =>
                    this._queryConnection(
                      typename,
                      fieldname,
                      endCursor,
                      options.connectionPageSize
                    )
                  )
                )
              ),
            ])
          );
        }
      )
    );
  }

  /**
   * Ingest data given by an `UpdateResult`. This is porcelain over
   * `_updateConnection` and `_updateOwnData`.
   *
   * See: `_findOutdated`.
   * See: `_queryFromPlan`.
   */
  _updateData(updateId: UpdateId, queryResult: UpdateResult): void {
    _inTransaction(this._db, () => {
      this._nontransactionallyUpdateData(updateId, queryResult);
    });
  }

  /**
   * As `_updateData`, but do not enter any transactions. Other methods
   * may call this method as a subroutine in a larger transaction.
   */
  _nontransactionallyUpdateData(
    updateId: UpdateId,
    queryResult: UpdateResult
  ): void {
    for (const topLevelKey of Object.keys(queryResult)) {
      if (topLevelKey.startsWith(_FIELD_PREFIXES.OWN_DATA)) {
        const rawValue: OwnDataUpdateResult | NodeConnectionsUpdateResult =
          queryResult[topLevelKey];
        const updateRecord: OwnDataUpdateResult = (rawValue: any);
        this._nontransactionallyUpdateOwnData(updateId, updateRecord);
      } else if (topLevelKey.startsWith(_FIELD_PREFIXES.NODE_CONNECTIONS)) {
        const rawValue: OwnDataUpdateResult | NodeConnectionsUpdateResult =
          queryResult[topLevelKey];
        const updateRecord: NodeConnectionsUpdateResult = (rawValue: any);
        for (const fieldname of Object.keys(updateRecord)) {
          if (fieldname === "id") {
            continue;
          }
          this._nontransactionallyUpdateConnection(
            updateId,
            updateRecord.id,
            fieldname,
            updateRecord[fieldname]
          );
        }
      } else {
        throw new Error(
          "Bad key in query result: " + JSON.stringify(topLevelKey)
        );
      }
    }
  }

  /**
   * Perform one step of the update loop: find outdated entities, fetch
   * their updates, and feed the results back into the database.
   *
   * Returns a promise that resolves to `true` if any changes were made.
   */
  async _updateStep(
    postQuery: ({+body: Queries.Body, +variables: {+[string]: any}}) => Promise<
      any
    >,
    options: {|
      +nodesLimit: number,
      +nodesOfTypeLimit: number,
      +connectionPageSize: number,
      +connectionLimit: number,
      +since: Date,
      +now: () => Date,
    |}
  ): Promise<boolean> {
    const queryPlan = this._findOutdated(options.since);
    if (queryPlan.objects.length === 0 && queryPlan.connections.length === 0) {
      return Promise.resolve(false);
    }
    const querySelections = this._queryFromPlan(queryPlan, {
      nodesLimit: options.nodesLimit,
      nodesOfTypeLimit: options.nodesOfTypeLimit,
      connectionPageSize: options.connectionPageSize,
      connectionLimit: options.connectionLimit,
    });
    const body = [Queries.build.query("MirrorUpdate", [], querySelections)];
    const result: UpdateResult = await postQuery({body, variables: {}});
    _inTransaction(this._db, () => {
      const updateId = this._createUpdate(options.now());
      this._nontransactionallyUpdateData(updateId, result);
    });
    return Promise.resolve(true);
  }

  /**
   * Update this mirror with new information from a remote GraphQL
   * server.
   *
   * The `postQuery` function should post a GraphQL query to the remote
   * server and return the `data` contents of its response, rejecting if
   * there are any errors. (Note that this requirement may change
   * backward-incompatibly in future versions of this module, in the
   * case that we wish to handle deletions without regenerating all
   * data.)
   *
   * The options are as follows:
   *
   *   - `since`: Fetch all data that is not known to be up-to-date as
   *     of the provided time. For instance, to fetch all objects more
   *     than a day old, use `new Date(new Date() - 86400e3)`.
   *
   *   - `now`: Function to yield the current date, which will be used
   *     as the modification time for any objects or connections updated
   *     in this process. Should probably be `() => new Date()`.
   *
   *   - `connectionPageSize`: Maximum number of entries to fetch in any
   *     given connection. Some providers have a hard limit of 100 on
   *     this value.
   *
   *   - `connectionLimit`: Maximum number of connections to fetch in a
   *     single query.
   *
   * See: `registerObject`.
   * See: `extract`.
   */
  async update(
    postQuery: ({+body: Queries.Body, +variables: {+[string]: any}}) => Promise<
      any
    >,
    options: {|
      +nodesLimit: number,
      +nodesOfTypeLimit: number,
      +connectionPageSize: number,
      +connectionLimit: number,
      +since: Date,
      +now: () => Date,
    |}
  ): Promise<void> {
    while (await this._updateStep(postQuery, options));
  }

  /**
   * Create a GraphQL selection set required to identify the typename
   * and ID for an object of the given declared type, which may be
   * either an object type or a union type. This is the minimal
   * whenever we find a reference to an object that we want to traverse
   * later.
   *
   * The resulting GraphQL should be embedded in the context of any node
   * of the provided type. For instance, `_queryShallow("Issue")`
   * returns a selection set that might replace the `?` in any of the
   * following queries:
   *
   *     repository(owner: "foo", name: "bar") {
   *       issues(first: 1) {
   *         nodes { ? }
   *       }
   *     }
   *
   *     nodes(ids: ["issue#1", "issue#2"]) { ? }
   *
   * The result of this query has type `NodeFieldResult`.
   *
   * This function is pure: it does not interact with the database.
   */
  _queryShallow(typename: Schema.Typename): Queries.Selection[] {
    const type = this._schema[typename];
    if (type == null) {
      // Should not be reachable via APIs.
      throw new Error("No such type: " + JSON.stringify(typename));
    }
    const b = Queries.build;
    switch (type.type) {
      case "SCALAR":
        throw new Error(
          "Cannot create selections for scalar type: " +
            JSON.stringify(typename)
        );
      case "ENUM":
        throw new Error(
          "Cannot create selections for enum type: " + JSON.stringify(typename)
        );
      case "OBJECT":
        return [b.field("__typename"), b.field("id")];
      case "UNION":
        return [
          b.field("__typename"),
          ...this._schemaInfo.unionTypes[typename].clauses.map(
            (clause: Schema.Typename) =>
              b.inlineFragment(clause, [b.field("id")])
          ),
        ];
      // istanbul ignore next
      default:
        throw new Error((type.type: empty));
    }
  }

  /**
   * Get the current value of the end cursor on a connection, or
   * `undefined` if the object has never been fetched. If no object by
   * the given ID is known, or the object does not have a connection of
   * the given name, then an error is thrown.
   *
   * Note that `null` is a valid end cursor and is distinct from
   * `undefined`.
   */
  _getEndCursor(
    objectId: Schema.ObjectId,
    fieldname: Schema.Fieldname
  ): EndCursor | void {
    const result: {|
      +initialized: 0 | 1,
      +endCursor: string | null,
    |} | void = this._db
      .prepare(
        dedent`\
          SELECT
              last_update IS NOT NULL AS initialized,
              end_cursor AS endCursor
          FROM connections
          WHERE object_id = :objectId AND fieldname = :fieldname
        `
      )
      // No need to worry about corruption in the form of multiple
      // matches: there is a UNIQUE(object_id, fieldname) constraint.
      .get({objectId, fieldname});
    if (result === undefined) {
      const s = JSON.stringify;
      throw new Error(`No such connection: ${s(objectId)}.${s(fieldname)}`);
    }
    return result.initialized ? result.endCursor : undefined;
  }

  /**
   * Create a GraphQL selection set to fetch elements from a collection,
   * specified by its enclosing object type and the connection field
   * name (for instance, "Repository" and "issues").
   *
   * If the connection has been queried before and you wish to fetch new
   * elements, use an appropriate end cursor. Use `undefined` otherwise.
   * Note that `null` is a valid end cursor and is distinct from
   * `undefined`. Note that these semantics are compatible with the
   * return value of `_getEndCursor`.
   *
   * If an end cursor for a particular node's connection was specified,
   * then the resulting GraphQL should be embedded in the context of
   * that node. For instance, if repository "foo/bar" has ID "baz" and
   * an end cursor of "c000" on its "issues" connection, then the
   * GraphQL emitted by `_queryConnection("issues", "c000")` might
   * replace the `?` in the following query:
   *
   *     node(id: "baz") { ? }
   *
   * If no end cursor was specified, then the resulting GraphQL may be
   * embedded in the context of _any_ node with a connection of the
   * appropriate fieldname. For instance, `_queryConnection("issues")`
   * emits GraphQL that may replace the `?` in either of the following
   * queries:
   *
   *     node(id: "baz") { ? }  # where "baz" is a repository ID
   *     repository(owner: "foo", name: "bar") { ? }
   *
   * Note, however, that this query will fetch nodes from the _start_ of
   * the connection. It would be wrong to append these results onto an
   * connection for which we have already fetched data.
   *
   * The result of this query has type `ConnectionFieldResult`.
   *
   * This function is pure: it does not interact with the database.
   *
   * See: `_getEndCursor`.
   * See: `_updateConnection`.
   */
  _queryConnection(
    typename: Schema.Typename,
    fieldname: Schema.Fieldname,
    endCursor: EndCursor | void,
    connectionPageSize: number
  ): Queries.Selection[] {
    if (this._schema[typename] == null) {
      throw new Error("No such type: " + JSON.stringify(typename));
    }
    if (this._schema[typename].type !== "OBJECT") {
      const s = JSON.stringify;
      throw new Error(
        `Cannot query connection on non-object type ${s(typename)} ` +
          `(${this._schema[typename].type})`
      );
    }
    const field = this._schemaInfo.objectTypes[typename].fields[fieldname];
    if (field == null) {
      const s = JSON.stringify;
      throw new Error(
        `Object type ${s(typename)} has no field ${s(fieldname)}`
      );
    }
    if (field.type !== "CONNECTION") {
      const s = JSON.stringify;
      throw new Error(
        `Cannot query non-connection field ${s(typename)}.${s(fieldname)} ` +
          `(${field.type})`
      );
    }
    const b = Queries.build;
    const connectionArguments: Queries.Arguments = {
      first: b.literal(connectionPageSize),
    };
    if (endCursor !== undefined) {
      connectionArguments.after = b.literal(endCursor);
    }
    return [
      b.field(fieldname, connectionArguments, [
        b.field("totalCount"),
        b.field("pageInfo", {}, [b.field("endCursor"), b.field("hasNextPage")]),
        b.field("nodes", {}, this._queryShallow(field.elementType)),
      ]),
    ];
  }

  /**
   * Ingest new entries in a connection on an existing object.
   *
   * The connection's last update will be set to the given value, which
   * must be an existing update lest an error be thrown.
   *
   * If the object does not exist or does not have a connection by the
   * given name, an error will be thrown.
   *
   * See: `_queryConnection`.
   * See: `_createUpdate`.
   */
  _updateConnection(
    updateId: UpdateId,
    objectId: Schema.ObjectId,
    fieldname: Schema.Fieldname,
    queryResult: ConnectionFieldResult
  ): void {
    _inTransaction(this._db, () => {
      this._nontransactionallyUpdateConnection(
        updateId,
        objectId,
        fieldname,
        queryResult
      );
    });
  }

  /**
   * As `_updateConnection`, but do not enter any transactions. Other
   * methods may call this method as a subroutine in a larger
   * transaction.
   */
  _nontransactionallyUpdateConnection(
    updateId: UpdateId,
    objectId: Schema.ObjectId,
    fieldname: Schema.Fieldname,
    queryResult: ConnectionFieldResult
  ): void {
    const db = this._db;
    const connectionId: number = this._db
      .prepare(
        dedent`\
          SELECT rowid FROM connections
          WHERE object_id = :objectId AND fieldname = :fieldname
        `
      )
      .pluck()
      .get({objectId, fieldname});
    // There is a UNIQUE(object_id, fieldname) constraint, so we don't
    // have to worry about pollution due to duplicates. But it's
    // possible that no such connection exists, indicating that the
    // object has not been registered. This is an error.
    if (connectionId === undefined) {
      const s = JSON.stringify;
      throw new Error(`No such connection: ${s(objectId)}.${s(fieldname)}`);
    }
    db.prepare(
      dedent`\
          UPDATE connections
          SET
              last_update = :updateId,
              total_count = :totalCount,
              has_next_page = :hasNextPage,
              end_cursor = :endCursor
          WHERE rowid = :connectionId
        `
    ).run({
      updateId,
      totalCount: queryResult.totalCount,
      hasNextPage: +queryResult.pageInfo.hasNextPage,
      endCursor: queryResult.pageInfo.endCursor,
      connectionId,
    });
    let nextIndex: number = db
      .prepare(
        dedent`\
          SELECT IFNULL(MAX(idx), 0) + 1 FROM connection_entries
          WHERE connection_id = :connectionId
        `
      )
      .pluck()
      .get({connectionId});
    const addEntry = db.prepare(
      dedent`\
        INSERT INTO connection_entries (connection_id, idx, child_id)
        VALUES (:connectionId, :idx, :childId)
      `
    );
    for (const node of queryResult.nodes) {
      const childId = this._nontransactionallyRegisterNodeFieldResult(node);
      const idx = nextIndex++;
      addEntry.run({connectionId, idx, childId});
    }
  }

  /**
   * Create a GraphQL selection set required to fetch the own-data
   * (primitives and node references) of an object, but not its
   * connection entries. The result depends only on the (concrete) type
   * of the object, not its ID.
   *
   * The provided typename must correspond to an object type, not a
   * union type; otherwise, an error will be thrown.
   *
   * The resulting GraphQL can be embedded into the context of any node
   * with the provided typename. For instance, if there are issues with
   * IDs "#1" and "#2", then `_queryOwnData("Issue")` emits GraphQL
   * that may replace the `?` in any of the following queries:
   *
   *     repository(owner: "foo", name: "bar") {
   *       issues(first: 1) { ? }
   *     }
   *     nodes(ids: ["#1", "#2") { ... on Issue { ? } }
   *     node(id: "#1") { ... on Issue { ? } }
   *
   * The result of this query has type `E`, where `E` is the element
   * type of `OwnDataUpdateResult`. That is, it is an object with shape
   * that depends on the provided typename: the name of each ID or
   * primitive field is a key mapping to a primitive value, and the name
   * of each node field is a key mapping to a `NodeFieldResult`.
   * Additionally, the attribute "__typename" maps to the node's
   * typename.
   *
   * This function is pure: it does not interact with the database.
   */
  _queryOwnData(typename: Schema.Typename): Queries.Selection[] {
    const type = this._schema[typename];
    if (type == null) {
      throw new Error(`No such type: ${JSON.stringify(typename)}`);
    }
    if (type.type !== "OBJECT") {
      throw new Error(
        `Not an object type: ${JSON.stringify(typename)} (${type.type})`
      );
    }
    const b = Queries.build;
    return [
      b.field("__typename"),
      ...Object.keys(type.fields)
        .map((fieldname) => {
          const field = type.fields[fieldname];
          switch (field.type) {
            case "ID":
              return b.field(fieldname);
            case "PRIMITIVE":
              return b.field(fieldname);
            case "NODE":
              if (field.fidelity.type === "UNFAITHFUL") {
                throw new Error(
                  "Handling unfaithful fields is not yet implemented"
                );
              }
              return b.field(
                fieldname,
                {},
                this._queryShallow(field.elementType)
              );
            case "CONNECTION":
              // Not handled by this function.
              return null;
            case "NESTED":
              return b.field(
                fieldname,
                {},
                Object.keys(field.eggs).map((childFieldname) => {
                  const childField = field.eggs[childFieldname];
                  switch (childField.type) {
                    case "PRIMITIVE":
                      return b.field(childFieldname);
                    case "NODE":
                      if (field.fidelity.type === "UNFAITHFUL") {
                        throw new Error(
                          "Handling unfaithful fields is not yet implemented"
                        );
                      }
                      return b.field(
                        childFieldname,
                        {},
                        this._queryShallow(childField.elementType)
                      );
                    // istanbul ignore next
                    default:
                      throw new Error((childField.type: empty));
                  }
                })
              );
            // istanbul ignore next
            default:
              throw new Error((field.type: empty));
          }
        })
        .filter(Boolean),
    ];
  }

  /**
   * Ingest own-data (primitive and link) updates for many objects of a
   * fixed concrete type. Every object in the input list must have the
   * same `__typename` attribute, which must be the name of a valid
   * object type.
   *
   * See: `_queryOwnData`.
   */
  _updateOwnData(updateId: UpdateId, queryResult: OwnDataUpdateResult): void {
    _inTransaction(this._db, () => {
      this._nontransactionallyUpdateOwnData(updateId, queryResult);
    });
  }

  /**
   * As `_updateOwnData`, but do not enter any transactions. Other
   * methods may call this method as a subroutine in a larger
   * transaction.
   */
  _nontransactionallyUpdateOwnData(
    updateId: UpdateId,
    queryResult: OwnDataUpdateResult
  ): void {
    if (queryResult.length === 0) {
      return;
    }
    const typename = queryResult[0].__typename;
    if (this._schema[typename] == null) {
      throw new Error("Unknown type: " + JSON.stringify(typename));
    }
    if (this._schema[typename].type !== "OBJECT") {
      throw new Error(
        "Cannot update data for non-object type: " +
          `${JSON.stringify(typename)} (${this._schema[typename].type})`
      );
    }

    const db = this._db;
    const objectType = this._schemaInfo.objectTypes[typename];

    // First, make sure that all objects for which we're given own data
    // actually exist and have the correct typename.
    {
      const doesObjectExist = db
        .prepare("SELECT COUNT(1) FROM objects WHERE id = ?")
        .pluck();
      for (const entry of queryResult) {
        if (!doesObjectExist.get(entry.id)) {
          throw new Error(
            "Cannot update data for nonexistent node: " +
              JSON.stringify(entry.id)
          );
        }
        if (entry.__typename !== typename) {
          const s = JSON.stringify;
          throw new Error(
            "Result set has inconsistent typenames: " +
              `${s(typename)} vs. ${s(entry.__typename)}`
          );
        }
      }
    }

    // Set each node's `lastUpdate` time.
    {
      const setLastUpdate: (objectId: Schema.ObjectId) => void = (() => {
        const stmt = db.prepare(
          dedent`\
            UPDATE objects SET last_update = :updateId
            WHERE id = :objectId
          `
        );
        const update = _makeSingleUpdateFunction(stmt);
        return (objectId) => update({objectId, updateId});
      })();
      for (const entry of queryResult) {
        setLastUpdate(entry.id);
      }
    }

    // Update each node's primitive data.
    //
    // (This typedef would be in the following block statement but for
    // facebook/flow#6961.)
    declare opaque type ParameterName: string;
    {
      const parameterNameFor = {
        topLevelField(fieldname: Schema.Fieldname): ParameterName {
          return ((["t", fieldname].join("_"): string): any);
        },
        nestedField(
          nestFieldname: Schema.Fieldname,
          eggFieldname: Schema.Fieldname
        ): ParameterName {
          return (([
            "n",
            String(nestFieldname.length),
            nestFieldname,
            eggFieldname,
          ].join("_"): string): any);
        },
      };
      const updatePrimitives: ({|
        +id: Schema.ObjectId,
        // These keys can be top-level primitive fields or the primitive
        // children of a nested field. The values are the JSON encodings
        // of the values received from the GraphQL response. For a
        // nested field, the value is `0` or `1` as the nested field is
        // `null` or not. (See docs on `_initialize` for more details.)
        +[parameterName: ParameterName]: string | 0 | 1,
      |}) => void = (() => {
        const updates: $ReadOnlyArray<string> = [].concat(
          objectType.primitiveFieldNames.map(
            (f) => `"${f}" = :${parameterNameFor.topLevelField(f)}`
          ),
          objectType.nestedFieldNames.map(
            (f) => `"${f}" = :${parameterNameFor.topLevelField(f)}`
          ),
          ...objectType.nestedFieldNames.map((f1) =>
            Object.keys(objectType.nestedFields[f1].primitives).map(
              (f2) => `"${f1}.${f2}" = :${parameterNameFor.nestedField(f1, f2)}`
            )
          )
        );
        if (updates.length === 0) {
          return () => {};
        }
        const tableName = _primitivesTableName(typename);
        const stmt = db.prepare(
          `UPDATE ${tableName} SET ${updates.join(", ")} WHERE id = :id`
        );
        return _makeSingleUpdateFunction(stmt);
      })();

      for (const entry of queryResult) {
        const primitives: {|
          +id: Schema.ObjectId,
          [ParameterName]: string | 0 | 1,
        |} = {id: entry.id};

        // Add top-level primitives.
        for (const fieldname of objectType.primitiveFieldNames) {
          const value: PrimitiveResult | NodeFieldResult | NestedFieldResult =
            entry[fieldname];
          const primitive: PrimitiveResult = (value: any);
          if (primitive === undefined) {
            const s = JSON.stringify;
            throw new Error(
              `Missing primitive ${s(fieldname)} on ${s(entry.id)} ` +
                `of type ${s(typename)} (got ${(primitive: empty)})`
            );
          }
          primitives[
            parameterNameFor.topLevelField(fieldname)
          ] = JSON.stringify(primitive);
        }

        // Add nested primitives.
        for (const nestFieldname of objectType.nestedFieldNames) {
          const nestValue:
            | PrimitiveResult
            | NodeFieldResult
            | NestedFieldResult =
            entry[nestFieldname];
          const topLevelNested: NestedFieldResult = (nestValue: any);
          if (topLevelNested === undefined) {
            const s = JSON.stringify;
            throw new Error(
              `Missing nested field ` +
                `${s(nestFieldname)} on ${s(entry.id)} ` +
                `of type ${s(typename)} (got ${(topLevelNested: empty)})`
            );
          }
          primitives[parameterNameFor.topLevelField(nestFieldname)] =
            topLevelNested == null ? 0 : 1;
          const eggFields = objectType.nestedFields[nestFieldname].primitives;
          for (const eggFieldname of Object.keys(eggFields)) {
            const eggValue: PrimitiveResult | NodeFieldResult =
              topLevelNested == null ? null : topLevelNested[eggFieldname];
            const primitive: PrimitiveResult = (eggValue: any);
            if (primitive === undefined) {
              const s = JSON.stringify;
              throw new Error(
                `Missing nested field ` +
                  `${s(nestFieldname)}.${s(eggFieldname)} ` +
                  `on ${s(entry.id)} ` +
                  `of type ${s(typename)} (got ${(primitive: empty)})`
              );
            }
            primitives[
              parameterNameFor.nestedField(nestFieldname, eggFieldname)
            ] = JSON.stringify(primitive);
          }
        }

        updatePrimitives(primitives);
      }
    }

    // Update each node's links.
    {
      const updateLink: ({|
        +parentId: string,
        +fieldname: string,
        +childId: string | null,
      |}) => void = (() => {
        const stmt = db.prepare(
          dedent`\
            UPDATE links SET child_id = :childId
            WHERE parent_id = :parentId AND fieldname = :fieldname
          `
        );
        return _makeSingleUpdateFunction(stmt);
      })();

      for (const entry of queryResult) {
        // Add top-level links.
        for (const fieldname of objectType.linkFieldNames) {
          const value: PrimitiveResult | NodeFieldResult | NestedFieldResult =
            entry[fieldname];
          const link: NodeFieldResult = (value: any);
          if (link === undefined) {
            const s = JSON.stringify;
            throw new Error(
              `Missing node reference ${s(fieldname)} on ${s(entry.id)} ` +
                `of type ${s(typename)} (got ${(link: empty)})`
            );
          }
          const childId = this._nontransactionallyRegisterNodeFieldResult(link);
          const parentId = entry.id;
          updateLink({parentId, fieldname, childId});
        }

        // Add nested links.
        for (const nestFieldname of objectType.nestedFieldNames) {
          const nestValue:
            | PrimitiveResult
            | NodeFieldResult
            | NestedFieldResult =
            entry[nestFieldname];
          const topLevelNested: NestedFieldResult = (nestValue: any);
          // No need for an extra safety check that this is present: we
          // handled that while covering primitive fields.
          const childFields = objectType.nestedFields[nestFieldname].nodes;
          for (const childFieldname of Object.keys(childFields)) {
            const childValue: PrimitiveResult | NodeFieldResult =
              topLevelNested == null ? null : topLevelNested[childFieldname];
            const link: NodeFieldResult = (childValue: any);
            if (link === undefined) {
              const s = JSON.stringify;
              throw new Error(
                `Missing nested field ` +
                  `${s(nestFieldname)}.${s(childFieldname)} ` +
                  `on ${s(entry.id)} ` +
                  `of type ${s(typename)} (got ${(link: empty)})`
              );
            }
            const childId = this._nontransactionallyRegisterNodeFieldResult(
              link
            );
            const fieldname = `${nestFieldname}.${childFieldname}`;
            const parentId = entry.id;
            updateLink({parentId, fieldname, childId});
          }
        }
      }
    }

    // Last-updates, primitives, and links all updated: we're done.
  }

  /**
   * Extract a structured object and all of its transitive dependencies
   * from the database.
   *
   * The result is an object whose keys are fieldnames, and whose values
   * are:
   *
   *   - for "__typename": the object's GraphQL typename;
   *   - for "id": the object's GraphQL ID;
   *   - for primitive fields: the corresponding primitive value;
   *   - for node reference fields: a reference to the corresponding
   *     extracted object, which may be `null`;
   *   - for connection fields: an in-order array of the corresponding
   *     extracted objects, each of which may be `null`;
   *   - for nested fields: an object with primitive and node reference
   *     fields in the same form as above (note: nested objects do not
   *     automatically have a "__typename" field).
   *
   * For instance, the result of `extract("issue:1")` might be:
   *
   *     {
   *       __typename: "Issue",
   *       id: "issue:1172",
   *       title: "bug: holding <Space> causes CPU to overheat",
   *       body: "We should fix this immediately.",
   *       author: {
   *         __typename: "User",
   *         id: "user:admin",
   *         login: "admin",
   *       },
   *       comments: [
   *         {
   *           __typename: "IssueComment",
   *           body: "I depend on this behavior; please do not change it.",
   *           author: {
   *             __typename: "User",
   *             id: "user:longtimeuser4",
   *             login: "longtimeuser4",
   *           },
   *         },
   *         {
   *           __typename: "IssueComment",
   *           body: "That's horrifying.",
   *           author: {
   *             __typename: "User",
   *             id: "user:admin",
   *             login: "admin",
   *           },
   *         },
   *       ],
   *       timeline: [
   *         {
   *           __typename: "Commit",
   *           messageHeadline: "reinstate CPU warmer (fixes #1172)",
   *           author: {
   *             date: "2001-02-03T04:05:06-07:00",
   *             user: {
   *               __typename: "User",
   *               id: "user:admin",
   *               login: "admin",
   *             }
   *           }
   *         }
   *       ],
   *     }
   *
   * (Here, "title" is a primitive, the "author" field on an issue is a
   * node reference, "comments" is a connection, and the "author" field
   * on a commit is a nested object.)
   *
   * The returned structure may be circular.
   *
   * If a node appears more than one time in the result---for instance,
   * the "user:admin" node above---all instances will refer to the same
   * object. However, objects are distinct across calls to `extract`, so
   * it is safe to deeply mutate the result of this function.
   *
   * The provided object ID must correspond to a known object, or an
   * error will be thrown. Furthermore, all transitive dependencies of
   * the object must have been at least partially loaded at some point,
   * or an error will be thrown.
   */
  extract(rootId: Schema.ObjectId): mixed {
    const db = this._db;
    return _inTransaction(db, () => {
      // We'll compute the transitive dependencies and store them into a
      // temporary table. To do so, we first find a free table name.
      const temporaryTableName: string = _nontransactionallyFindUnusedTableName(
        db,
        "tmp_transitive_dependencies_"
      );
      db.prepare(
        `CREATE TEMPORARY TABLE ${temporaryTableName} ` +
          "(id TEXT NOT NULL PRIMARY KEY, typename TEXT NOT NULL)"
      ).run();

      try {
        db.prepare(
          dedent`\
            WITH RECURSIVE
            direct_dependencies (parent_id, child_id) AS (
                SELECT parent_id, child_id FROM links
                WHERE child_id IS NOT NULL
                UNION
                SELECT DISTINCT
                    connections.object_id AS parent_id,
                    connection_entries.child_id AS child_id
                FROM connections JOIN connection_entries
                ON connections.rowid = connection_entries.connection_id
                WHERE child_id IS NOT NULL
            ),
            transitive_dependencies (id) AS (
                VALUES (:rootId) UNION
                SELECT direct_dependencies.child_id
                FROM transitive_dependencies JOIN direct_dependencies
                ON transitive_dependencies.id = direct_dependencies.parent_id
            )
            INSERT INTO ${temporaryTableName} (id, typename)
            SELECT objects.id AS id, objects.typename AS typename
            FROM objects JOIN transitive_dependencies
            ON objects.id = transitive_dependencies.id
          `
        ).run({rootId});
        const typenames: $ReadOnlyArray<Schema.Typename> = db
          .prepare(`SELECT DISTINCT typename FROM ${temporaryTableName}`)
          .pluck()
          .all();

        // Check to make sure all required objects and connections have
        // been updated at least once.
        {
          const neverUpdatedEntry: void | {|
            +id: Schema.ObjectId,
            +fieldname: null | Schema.Fieldname,
          |} = db
            .prepare(
              dedent`\
                SELECT objects.id AS id, NULL as fieldname
                FROM ${temporaryTableName}
                JOIN objects USING (id)
                WHERE objects.last_update IS NULL
                UNION ALL
                SELECT objects.id AS id, connections.fieldname AS fieldname
                FROM ${temporaryTableName}
                JOIN objects
                    USING (id)
                LEFT OUTER JOIN connections
                    ON objects.id = connections.object_id
                WHERE
                    connections.rowid IS NOT NULL
                    AND connections.last_update IS NULL
              `
            )
            .get();
          if (neverUpdatedEntry !== undefined) {
            const entry = neverUpdatedEntry;
            const s = JSON.stringify;
            const missingData: string =
              entry.fieldname == null
                ? "own data"
                : `${s(entry.fieldname)} connection`;
            throw new Error(
              `${s(rootId)} transitively depends on ${s(entry.id)}, ` +
                `but that object's ${missingData} has never been fetched`
            );
          }
        }

        // Constructing the result set inherently requires mutation,
        // because the object graph can have cycles. We start by
        // creating a record for each object, with just that object's
        // primitive data and typename. Then, we link in node references
        // and connection entries.
        const allObjects: Map<Schema.ObjectId, Object> = new Map();
        for (const typename of typenames) {
          const objectType = this._schemaInfo.objectTypes[typename];
          // istanbul ignore if: should not be possible using the
          // publicly accessible APIs
          if (objectType == null) {
            throw new Error(
              `Corruption: unknown object type ${JSON.stringify(typename)}`
            );
          }
          const primitivesTableName = _primitivesTableName(typename);
          const selections: $ReadOnlyArray<string> = [].concat(
            [`${primitivesTableName}.id AS id`],
            objectType.primitiveFieldNames.map(
              (fieldname) =>
                `${primitivesTableName}."${fieldname}" AS "${fieldname}"`
            ),
            objectType.nestedFieldNames.map(
              (fieldname) =>
                `${primitivesTableName}."${fieldname}" AS "${fieldname}"`
            ),
            ...objectType.nestedFieldNames.map((f1) =>
              Object.keys(objectType.nestedFields[f1].primitives).map(
                (f2) => `${primitivesTableName}."${f1}.${f2}" AS "${f1}.${f2}"`
              )
            )
          );
          const rows: $ReadOnlyArray<{|
            +id: Schema.ObjectId,
            +[Schema.Fieldname]: string | 0 | 1,
          |}> = db
            .prepare(
              dedent`\
                SELECT ${selections.join(", ")}
                FROM ${temporaryTableName} JOIN ${primitivesTableName}
                USING (id)
              `
            )
            .all();
          for (const row of rows) {
            const object = {};
            object.id = row.id;
            object.__typename = typename;
            for (const fieldname of objectType.nestedFieldNames) {
              const isPresent: string | 0 | 1 = row[fieldname];
              // istanbul ignore if: should not be reachable
              if (isPresent !== 0 && isPresent !== 1) {
                const s = JSON.stringify;
                const id = object.id;
                throw new Error(
                  `Corruption: nested field ${s(fieldname)} on ${s(id)} ` +
                    `set to ${String(isPresent)}`
                );
              }
              if (isPresent) {
                // We'll add primitives and links onto this object.
                object[fieldname] = {};
              } else {
                object[fieldname] = null;
              }
            }
            for (const key of Object.keys(row)) {
              if (key === "id") continue;
              const rawValue = row[key];
              if (rawValue === 0 || rawValue === 1) {
                // Name of a nested field; already processed.
                continue;
              }
              const value = JSON.parse(rawValue);
              const parts = key.split(".");
              switch (parts.length) {
                case 1:
                  object[key] = value;
                  break;
                case 2: {
                  const [nestName, eggName] = parts;
                  if (object[nestName] !== null) {
                    object[nestName][eggName] = value;
                  }
                  break;
                }
                // istanbul ignore next: should not be possible
                default:
                  throw new Error(
                    `Corruption: bad field name: ${JSON.stringify(key)}`
                  );
              }
            }
            allObjects.set(object.id, object);
          }
        }

        // Add links.
        {
          const getLinks = db.prepare(
            dedent`\
              SELECT
                parent_id AS parentId,
                fieldname AS fieldname,
                child_id AS childId
              FROM ${temporaryTableName} JOIN links
              ON ${temporaryTableName}.id = links.parent_id
            `
          );
          for (const link: {|
            +parentId: Schema.ObjectId,
            +fieldname: Schema.Fieldname,
            +childId: Schema.ObjectId | null,
          |} of getLinks.iterate()) {
            const parent = NullUtil.get(allObjects.get(link.parentId));
            const child =
              link.childId == null
                ? null
                : NullUtil.get(allObjects.get(link.childId));
            const {fieldname} = link;
            const parts = fieldname.split(".");
            switch (parts.length) {
              case 1:
                parent[fieldname] = child;
                break;
              case 2: {
                const [nestName, eggName] = parts;
                if (parent[nestName] !== null) {
                  parent[nestName][eggName] = child;
                }
                break;
              }
              // istanbul ignore next: should not be possible
              default:
                throw new Error(
                  `Corruption: bad link name: ${JSON.stringify(fieldname)}`
                );
            }
          }
        }

        // Add connections.
        {
          const getConnectionData = db.prepare(
            dedent`\
              SELECT
                  objects.id AS parentId,
                  connections.fieldname AS fieldname,
                  connection_entries.connection_id IS NOT NULL AS hasContents,
                  connection_entries.child_id AS childId
              FROM ${temporaryTableName}
              JOIN objects
                  USING (id)
              JOIN connections
                  ON objects.id = connections.object_id
              LEFT OUTER JOIN connection_entries
                  ON connections.rowid = connection_entries.connection_id
              ORDER BY
                  objects.id, connections.fieldname, connection_entries.idx ASC
            `
          );
          for (const datum: {|
            +parentId: Schema.ObjectId,
            +fieldname: Schema.Fieldname,
            +hasContents: 0 | 1,
            +childId: Schema.ObjectId | null,
          |} of getConnectionData.iterate()) {
            const parent = NullUtil.get(allObjects.get(datum.parentId));
            if (parent[datum.fieldname] === undefined) {
              parent[datum.fieldname] = [];
            }
            if (datum.hasContents) {
              const child =
                datum.childId == null
                  ? null
                  : NullUtil.get(allObjects.get(datum.childId));
              parent[datum.fieldname].push(child);
            }
          }
        }

        const result = allObjects.get(rootId);
        if (result === undefined) {
          throw new Error("No such object: " + JSON.stringify(rootId));
        }
        return result;
      } finally {
        this._db.prepare(`DROP TABLE ${temporaryTableName}`).run();
      }
    });
  }
}

/**
 * Decomposition of a schema, grouping types by their kind (object vs.
 * union) and object fields by their kind (primitive vs. link vs.
 * connection).
 *
 * All arrays contain elements in arbitrary order.
 */
type SchemaInfo = {|
  +objectTypes: {|
    +[Schema.Typename]: {|
      +fields: {|+[Schema.Fieldname]: Schema.FieldType|},
      +nestedFields: {|
        +[Schema.Fieldname]: {|
          +primitives: {|
            +[Schema.Fieldname]: Schema.PrimitiveFieldType,
          |},
          +nodes: {|
            +[Schema.Fieldname]: Schema.NodeFieldType,
          |},
        |},
      |},
      +primitiveFieldNames: $ReadOnlyArray<Schema.Fieldname>,
      +linkFieldNames: $ReadOnlyArray<Schema.Fieldname>,
      +connectionFieldNames: $ReadOnlyArray<Schema.Fieldname>,
      +nestedFieldNames: $ReadOnlyArray<Schema.Fieldname>,
      // There is always exactly one ID field, so it needs no
      // special representation. (It's still included in the `fields`
      // dictionary, though.)
    |},
  |},
  +unionTypes: {|
    +[Schema.Fieldname]: {|
      +clauses: $ReadOnlyArray<Schema.Typename>,
    |},
  |},
|};

export function _buildSchemaInfo(schema: Schema.Schema): SchemaInfo {
  const result = {
    objectTypes: (({}: any): {|
      [Schema.Typename]: {|
        +fields: {|+[Schema.Fieldname]: Schema.FieldType|},
        +nestedFields: {|
          [Schema.Fieldname]: {|
            +primitives: {|
              [Schema.Fieldname]: Schema.PrimitiveFieldType,
            |},
            +nodes: {|
              [Schema.Fieldname]: Schema.NodeFieldType,
            |},
          |},
        |},
        +primitiveFieldNames: Array<Schema.Fieldname>,
        +linkFieldNames: Array<Schema.Fieldname>,
        +connectionFieldNames: Array<Schema.Fieldname>,
        +nestedFieldNames: Array<Schema.Fieldname>,
      |},
    |}),
    unionTypes: (({}: any): {|
      [Schema.Fieldname]: {|
        +clauses: $ReadOnlyArray<Schema.Typename>,
      |},
    |}),
  };
  for (const typename of Object.keys(schema)) {
    const type = schema[typename];
    switch (type.type) {
      case "SCALAR":
        // Nothing to do.
        break;
      case "ENUM":
        // Nothing to do.
        break;
      case "OBJECT": {
        const entry: {|
          +fields: {|+[Schema.Fieldname]: Schema.FieldType|},
          +nestedFields: $PropertyType<
            $ElementType<
              $PropertyType<typeof result, "objectTypes">,
              Schema.Fieldname
            >,
            "nestedFields"
          >,
          +primitiveFieldNames: Array<Schema.Fieldname>,
          +linkFieldNames: Array<Schema.Fieldname>,
          +connectionFieldNames: Array<Schema.Fieldname>,
          +nestedFieldNames: Array<Schema.Fieldname>,
        |} = {
          fields: type.fields,
          nestedFields: ({}: any),
          primitiveFieldNames: [],
          linkFieldNames: [],
          connectionFieldNames: [],
          nestedFieldNames: [],
        };
        result.objectTypes[typename] = entry;
        for (const fieldname of Object.keys(type.fields)) {
          const field = type.fields[fieldname];
          switch (field.type) {
            case "ID":
              break;
            case "PRIMITIVE":
              entry.primitiveFieldNames.push(fieldname);
              break;
            case "NODE":
              if (field.fidelity.type === "UNFAITHFUL") {
                throw new Error(
                  "Handling unfaithful fields is not yet implemented"
                );
              }
              entry.linkFieldNames.push(fieldname);
              break;
            case "CONNECTION":
              entry.connectionFieldNames.push(fieldname);
              break;
            case "NESTED": {
              entry.nestedFieldNames.push(fieldname);
              const nestedFieldData: $ElementType<
                $PropertyType<typeof entry, "nestedFields">,
                Schema.Fieldname
              > = {primitives: ({}: any), nodes: ({}: any)};
              for (const eggFieldname of Object.keys(field.eggs)) {
                const eggField = field.eggs[eggFieldname];
                switch (eggField.type) {
                  case "PRIMITIVE":
                    nestedFieldData.primitives[eggFieldname] = eggField;
                    break;
                  case "NODE":
                    if (eggField.fidelity.type === "UNFAITHFUL") {
                      throw new Error(
                        "Handling unfaithful fields is not yet implemented"
                      );
                    }
                    nestedFieldData.nodes[eggFieldname] = eggField;
                    break;
                  // istanbul ignore next
                  default:
                    throw new Error((eggField.type: empty));
                }
              }
              entry.nestedFields[fieldname] = nestedFieldData;
              break;
            }
            // istanbul ignore next
            default:
              throw new Error((field.type: empty));
          }
        }
        break;
      }
      case "UNION": {
        const entry = {clauses: Object.keys(type.clauses)};
        result.unionTypes[typename] = entry;
        break;
      }
      // istanbul ignore next
      default:
        throw new Error((type.type: empty));
    }
  }
  return result;
}

type UpdateId = number;

/**
 * A set of objects and connections that should be updated.
 */
type QueryPlan = {|
  +objects: $ReadOnlyArray<{|
    +typename: Schema.Typename,
    +id: Schema.ObjectId,
  |}>,
  +connections: $ReadOnlyArray<{|
    +objectTypename: Schema.Typename,
    +objectId: Schema.ObjectId,
    +fieldname: Schema.Fieldname,
    +endCursor: EndCursor | void, // `undefined` if never fetched
  |}>,
  +typenames: $ReadOnlyArray<{|
    +id: Schema.ObjectId,
  |}>,
|};

/**
 * An `endCursor` of a GraphQL `pageInfo` object, denoting where the
 * cursor should continue reading the next page. This is `null` when the
 * cursor is at the beginning of the connection (i.e., when the
 * connection is empty, or when `first: 0` is provided).
 */
type EndCursor = string | null;

type PrimitiveResult = string | number | boolean | null;
type NodeFieldResult = {|
  +__typename: Schema.Typename,
  +id: Schema.ObjectId,
|} | null;
type ConnectionFieldResult = {|
  +totalCount: number,
  +pageInfo: {|+hasNextPage: boolean, +endCursor: string | null|},
  +nodes: $ReadOnlyArray<NodeFieldResult>,
|};
type NestedFieldResult = {
  +[Schema.Fieldname]: PrimitiveResult | NodeFieldResult,
} | null;

/**
 * Result describing own-data for many nodes of a given type. Whether a
 * value is a `PrimitiveResult` or a `NodeFieldResult` is determined by
 * the schema.
 *
 * This type would be exact but for facebook/flow#2977, et al.
 */
type OwnDataUpdateResult = $ReadOnlyArray<{
  +__typename: Schema.Typename, // the same for all entries
  +id: Schema.ObjectId,
  +[nonConnectionFieldname: Schema.Fieldname]:
    | PrimitiveResult
    | NodeFieldResult
    | NestedFieldResult,
}>;

/**
 * Result describing new elements for connections on a single node.
 *
 * This type would be exact but for facebook/flow#2977, et al.
 */
type NodeConnectionsUpdateResult = {
  +id: Schema.ObjectId,
  +[connectionFieldname: Schema.Fieldname]: ConnectionFieldResult,
};

/**
 * Result describing both own-data updates and connection updates. Each
 * key's prefix determines what type of results the corresponding value
 * represents (see constants below). No field prefix is a prefix of
 * another, so this characterization is complete.
 *
 * This type would be exact but for facebook/flow#2977, et al.
 *
 * See: `_FIELD_PREFIXES`.
 */
type UpdateResult = {
  // The prefix of each key determines what type of results the value
  // represents. See constants below.
  +[string]: OwnDataUpdateResult | NodeConnectionsUpdateResult,
};

export const _FIELD_PREFIXES = Object.freeze({
  /**
   * A key of an `UpdateResult` has this prefix if and only if the
   * corresponding value represents `OwnDataUpdateResult`s.
   */
  OWN_DATA: "owndata_",

  /**
   * A key of an `UpdateResult` has this prefix if and only if the
   * corresponding value represents `NodeConnectionsUpdateResult`s.
   */
  NODE_CONNECTIONS: "node_",
});

/**
 * Execute a function inside a database transaction.
 *
 * The database must not be in a transaction. A new transaction will be
 * entered, and then the callback will be invoked.
 *
 * If the callback completes normally, then its return value is passed
 * up to the caller, and the currently active transaction (if any) is
 * committed.
 *
 * If the callback throws an error, then the error is propagated to the
 * caller, and the currently active transaction (if any) is rolled back.
 *
 * Note that the callback may choose to commit or roll back the
 * transaction before returning or throwing an error. Conversely, note
 * that if the callback commits the transaction, and then begins a new
 * transaction but does not end it, then this function will commit the
 * new transaction if the callback returns (or roll it back if it
 * throws).
 */
export function _inTransaction<R>(db: Database, fn: () => R): R {
  if (db.inTransaction) {
    throw new Error("already in transaction");
  }
  try {
    db.prepare("BEGIN").run();
    const result = fn();
    if (db.inTransaction) {
      db.prepare("COMMIT").run();
    }
    return result;
  } finally {
    if (db.inTransaction) {
      db.prepare("ROLLBACK").run();
    }
  }
}

/*
 * In some cases, we need to interpolate user input in SQL queries in
 * positions that do not allow bound variables in prepared statements
 * (e.g., table and column names). In these cases, we manually sanitize.
 *
 * If this function returns `true`, then its argument may be safely
 * included in a SQL identifier. If it returns `false`, then no such
 * guarantee is made (this function is overly conservative, so it is
 * possible that the argument may in fact be safe).
 *
 * For instance, the function will return `true` if passed "col", but
 * will return `false` if passed "'); DROP TABLE objects; --".
 */
function isSqlSafe(token: string) {
  return !token.match(/[^A-Za-z0-9_]/);
}

/**
 * Get the name of the table used to store primitive data for objects of
 * the given type, which should be SQL-safe lest an error be thrown.
 *
 * Note that the resulting string is double-quoted.
 */
function _primitivesTableName(typename: Schema.Typename) {
  // istanbul ignore if
  if (!isSqlSafe(typename)) {
    // This shouldn't be reachable---we should have caught it earlier.
    // But checking it anyway is cheap.
    throw new Error(
      "Invariant violation: invalid object type name " +
        JSON.stringify(typename)
    );
  }
  return `"primitives_${typename}"`;
}

/**
 * Convert a prepared statement into a JS function that executes that
 * statement and asserts that it makes exactly one change to the
 * database.
 *
 * The prepared statement must use only named parameters, not positional
 * parameters.
 *
 * The prepared statement must not return data (e.g., INSERT and UPDATE
 * are okay; SELECT is not).
 *
 * The statement is not executed inside an additional transaction, so in
 * the case that the assertion fails, the effects of the statement are
 * not rolled back by this function.
 *
 * This is useful when the statement is like `UPDATE ... WHERE id = ?`
 * and it is assumed that `id` is a primary key for a record already
 * exists---if either existence or uniqueness fails, this method will
 * raise an error quickly instead of leading to a corrupt state.
 *
 * For example, this code...
 *
 *     const setName: ({|+userId: string, +newName: string|}) => void =
 *       _makeSingleUpdateFunction(
 *         "UPDATE users SET name = :newName WHERE id = :userId"
 *       );
 *     setName({userId: "user:foo", newName: "The Magnificent Foo"});
 *
 * ...will update `user:foo`'s name, or throw an error if there is no
 * such user or if multiple users have this ID.
 */
export function _makeSingleUpdateFunction<Args: BindingDictionary>(
  stmt: Statement
): (Args) => void {
  if (stmt.returnsData) {
    throw new Error(
      "Cannot create update function for statement that returns data: " +
        stmt.source
    );
  }
  return (args: Args) => {
    const result = stmt.run(args);
    if (result.changes !== 1) {
      throw new Error(
        "Bad change count: " +
          JSON.stringify({source: stmt.source, args, changes: result.changes})
      );
    }
  };
}

/**
 * Find a name for a new table (or index) that starts with the given
 * prefix and is not used by any current table or index.
 *
 * This function does not actually create any tables. Consider including
 * it in a transaction that subsequently creates the table.
 *
 * The provided prefix must be a SQL-safe string, or an error will be
 * thrown.
 *
 * The result will be a SQL-safe string, and will not need to be quoted
 * unless the provided prefix does.
 *
 * See: `isSqlSafe`.
 */
export function _nontransactionallyFindUnusedTableName(
  db: Database,
  prefix: string
) {
  if (!isSqlSafe(prefix)) {
    throw new Error("Unsafe table name prefix: " + JSON.stringify(prefix));
  }
  const result: string = db
    .prepare(
      dedent`\
        SELECT :prefix || (IFNULL(MAX(CAST(suffix AS INTEGER)), 0) + 1)
        FROM (
            SELECT SUBSTR(name, LENGTH(:prefix) + 1) AS suffix
            FROM sqlite_master
            WHERE SUBSTR(name, 1, LENGTH(:prefix)) = :prefix
        )
      `
    )
    .pluck()
    .get({prefix});
  // istanbul ignore if: should not be possible---it only has the
  // prefix (which is safe as defined above) and a trailing integer.
  if (!isSqlSafe(result)) {
    throw new Error(
      "Invariant violation: unsafe table name: " + JSON.stringify(result)
    );
  }
  return result;
}
