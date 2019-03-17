// @flow
/*
 * API to scrape data from a GitHub repo using the GitHub API. See the
 * docstring of the default export for more details.
 */

import Database from "better-sqlite3";
import fetch from "isomorphic-fetch";
import path from "path";
import retry from "retry";

import {type RepoId, repoIdToString} from "../../core/repoId";
import {Mirror} from "../../graphql/mirror";
import * as Queries from "../../graphql/queries";
import {stringify, inlineLayout, type Body} from "../../graphql/queries";
import * as Schema from "../../graphql/schema";
import {BLACKLISTED_IDS} from "./blacklistedObjectIds";
import type {Repository} from "./graphqlTypes";
import schema from "./schema";

/**
 * Scrape data from a GitHub repo using the GitHub API.
 *
 * @param {RepoId} repoId
 *    the GitHub repository to be scraped
 * @param {String} token
 *    authentication token to be used for the GitHub API; generate a
 *    token at: https://github.com/settings/tokens
 * @return {Promise<object>}
 *    a promise that resolves to a JSON object containing the data
 *    scraped from the repository, with data format to be specified
 *    later
 */
export default async function fetchGithubRepo(
  repoId: RepoId,
  options: {|+token: string, +cacheDirectory: string|}
): Promise<Repository> {
  const {token, cacheDirectory} = options;
  console.error(repoId);

  const validToken = /^[A-Fa-f0-9]{40}$/;
  if (!validToken.test(token)) {
    throw new Error(`Invalid token: ${token}`);
  }
  const postQueryWithToken = (payload) => postQuery(payload, token);

  const resolvedId: Schema.ObjectId = await resolveRepositoryGraphqlId(
    postQueryWithToken,
    repoId
  );

  // Key the cache file against the GraphQL ID, but make sure that the
  // name is valid and uniquely identifying even on case-insensitive
  // filesystems (HFS, HFS+, APFS, NTFS) or filesystems preventing
  // equals signs in file names.
  const dbFilename = `mirror_${Buffer.from(resolvedId).toString("hex")}.db`;
  const db = new Database(path.join(cacheDirectory, dbFilename));
  const mirror = new Mirror(db, schema(), {blacklistedIds: BLACKLISTED_IDS});
  mirror.registerObject({typename: "Repository", id: resolvedId});

  // These are arbitrary tuning parameters.
  // TODO(#638): Design a configuration system for plugins.
  const ttlSeconds = 60 * 60 * 24 * 7;
  const nodesLimit = 100;
  const connectionLimit = 100;
  const typenamesLimit = 100;

  await mirror.update(postQueryWithToken, {
    since: new Date(Date.now() - ttlSeconds * 1000),
    now: () => new Date(),
    // These properties are arbitrary tuning parameters.
    nodesLimit,
    connectionLimit,
    typenamesLimit,
    // These values are the maxima allowed by GitHub.
    nodesOfTypeLimit: 100,
    connectionPageSize: 100,
  });
  return ((mirror.extract(resolvedId): any): Repository);
}

const GITHUB_GRAPHQL_SERVER = "https://api.github.com/graphql";

type GithubResponseError =
  | {|+type: "FETCH_ERROR", retry: false, error: Error|}
  | {|+type: "GRAPHQL_ERROR", retry: false, error: mixed|}
  | {|+type: "RATE_LIMIT_EXCEEDED", retry: false, error: mixed|}
  | {|+type: "GITHUB_INTERNAL_EXECUTION_ERROR", retry: true, error: mixed|}
  | {|+type: "NO_DATA", retry: true, error: mixed|};

// Fetch against the GitHub API with the provided options, returning a
// promise that either resolves to the GraphQL result data or rejects
// to a `GithubResponseError`.
function tryGithubFetch(fetch, fetchOptions): Promise<any> {
  return fetch(GITHUB_GRAPHQL_SERVER, fetchOptions).then(
    (x) =>
      x.json().then((x) => {
        if (x.errors) {
          if (
            x.errors.length === 1 &&
            x.errors[0].message.includes("it could be a GitHub bug")
          ) {
            return Promise.reject(
              ({
                type: "GITHUB_INTERNAL_EXECUTION_ERROR",
                retry: true,
                error: x,
              }: GithubResponseError)
            );
          } else if (
            x.errors.length === 1 &&
            x.errors[0].type === "RATE_LIMITED"
          ) {
            return Promise.reject(
              ({
                type: "RATE_LIMIT_EXCEEDED",
                retry: false,
                error: x,
              }: GithubResponseError)
            );
          } else {
            return Promise.reject(
              ({
                type: "GRAPHQL_ERROR",
                retry: false,
                error: x,
              }: GithubResponseError)
            );
          }
        }
        if (x.data === undefined) {
          // See https://github.com/sourcecred/sourcecred/issues/350.
          return Promise.reject(
            ({type: "NO_DATA", retry: true, error: x}: GithubResponseError)
          );
        }
        return Promise.resolve(x.data);
      }),
    (e) =>
      Promise.reject(
        ({type: "FETCH_ERROR", retry: false, error: e}: GithubResponseError)
      )
  );
}

function retryGithubFetch(fetch, fetchOptions) {
  return new Promise((resolve, reject) => {
    const operation = retry.operation();
    operation.attempt(() => {
      tryGithubFetch(fetch, fetchOptions)
        .then((result) => {
          resolve(result);
        })
        .catch((error) => {
          if (error.retry && operation.retry(true)) {
            return;
          } else {
            reject(error);
          }
        });
    });
  });
}

export async function postQuery(
  {body, variables}: {+body: Body, +variables: mixed},
  token: string
): Promise<any> {
  const postBody = JSON.stringify({
    query: stringify.body(body, inlineLayout()),
    variables: variables,
  });
  const fetchOptions = {
    method: "POST",
    body: postBody,
    headers: {
      Authorization: `bearer ${token}`,
    },
  };
  return retryGithubFetch(fetch, fetchOptions).catch(
    (error: GithubResponseError) => {
      const type = error.type;
      switch (type) {
        case "GITHUB_INTERNAL_EXECUTION_ERROR":
        case "NO_DATA":
          console.error(
            "GitHub query failed! We're tracking these issues at " +
              "https://github.com/sourcecred/sourcecred/issues/350.\n" +
              "If the error is a timeout or abuse rate limit, you can " +
              "try loading a smaller repo, or trying again in a few minutes.\n" +
              "The actual failed response can be found below:\n" +
              "================================================="
          );
          console.error(error.error);
          break;
        case "GRAPHQL_ERROR":
          console.error(
            "Unexpected GraphQL error; this may be a bug in SourceCred: ",
            JSON.stringify({postBody: postBody, error: error.error})
          );
          break;
        case "RATE_LIMIT_EXCEEDED":
          console.error(
            "You've exceeded your hourly GitHub rate limit.\n" +
              "You'll need to wait until it resets."
          );
          break;
        case "FETCH_ERROR":
          // Network error; no need for additional commentary.
          break;
        default:
          throw new Error((type: empty));
      }
      return Promise.reject(error);
    }
  );
}

async function resolveRepositoryGraphqlId(
  postQuery: ({+body: Body, +variables: mixed}) => Promise<any>,
  repoId: RepoId
): Promise<Schema.ObjectId> {
  const b = Queries.build;
  const payload = {
    body: [
      b.query(
        "ResolveRepositoryId",
        [b.param("owner", "String!"), b.param("name", "String!")],
        [
          b.field(
            "repository",
            {owner: b.variable("owner"), name: b.variable("name")},
            [b.field("id")]
          ),
        ]
      ),
    ],
    variables: {owner: repoId.owner, name: repoId.name},
  };
  const data: {|+repository: null | {|+id: string|}|} = await postQuery(
    payload
  );
  if (data.repository == null) {
    throw new Error(
      `No such repository: ${repoIdToString(repoId)} ` +
        `(response data: ${JSON.stringify(data)})`
    );
  }
  return data.repository.id;
}
