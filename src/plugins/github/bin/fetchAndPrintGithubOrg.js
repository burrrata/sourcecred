// @flow
/*
 * Command-line utility to fetch GitHub data using the API in
 * ../fetchGithubRepo, and print it to stdout. Useful for testing or
 * saving some data to disk.
 *
 * Usage:
 *
 *   node bin/fetchAndPrintGithubRepo.js REPO_OWNER REPO_NAME [TOKEN]
 *
 * where TOKEN is an optional GitHub authentication token, as generated
 * from https://github.com/settings/tokens/new.
 */

import stringify from "json-stable-stringify";

import {fetchGithubOrg} from "../fetchGithubOrg";

function parseArgs() {
  const argv = process.argv.slice(2);
  const fail = () => {
    const invocation = process.argv.slice(0, 2).join(" ");
    throw new Error(
      `Usage: ${invocation} ORGANIZATION_NAME GITHUB_TOKEN [PAGE_SIZE]`
    );
  };
  if (argv.length < 2) {
    fail();
  }
  const [organization, githubToken, ...rest] = argv;
  let pageSize: ?number;
  if (rest.length === 1) {
    pageSize = Number(rest[0]);
  }
  const result = {organization, githubToken, pageSize};
  if (rest.length > 1) {
    fail();
  }
  return result;
}

function main() {
  const {organization, githubToken, pageSize} = parseArgs();
  fetchGithubOrg(organization, githubToken, pageSize)
    .then((data) => {
      console.log(stringify(data, {space: 4}));
    })
    .catch((errors) => {
      console.error("Errors processing the result:");
      console.error(errors);
      process.exit(1);
    });
}

main();
