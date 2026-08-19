/**
 * lib/octokit.js
 * ──────────────
 * Thin wrapper around @octokit/rest for committing content pages and
 * taxonomy updates directly to the repository via the GitHub REST API.
 *
 * All write operations require the user to supply a Personal Access Token
 * (PAT) with `contents:write` scope. Admins and Editors obtain this via
 * a dedicated "Connect Repository" flow in the CMS (stored in sessionStorage
 * under "gh_pat" — never persisted server-side).
 */

import { Octokit } from "@octokit/rest";

const OWNER = process.env.NEXT_PUBLIC_GITHUB_REPO_OWNER ?? "";
const REPO = process.env.NEXT_PUBLIC_GITHUB_REPO_NAME ?? "Lessons";
const DEFAULT_BRANCH = process.env.NEXT_PUBLIC_GITHUB_DEFAULT_BRANCH ?? "main";

/** Create an Octokit instance authenticated with the user's PAT. */
function getOctokit(token) {
  if (!token) throw new Error("GitHub PAT required to commit content.");
  return new Octokit({ auth: token });
}

/**
 * Commit (create or update) a single file in the repository.
 *
 * @param {object} opts
 * @param {string} opts.path        - Repo-relative path, e.g. "content/sixth/math-6/decimal-operations/explanation.json"
 * @param {string} opts.content     - UTF-8 content to write
 * @param {string} opts.message     - Commit message
 * @param {string} opts.token       - GitHub PAT
 * @param {string} [opts.branch]    - Target branch (defaults to DEFAULT_BRANCH)
 * @returns {Promise<object>}       - GitHub API response data
 */
export async function commitFile({ path, content, message, token, branch = DEFAULT_BRANCH }) {
  const octokit = getOctokit(token);

  // Fetch current SHA (needed for updates; undefined for new files)
  let sha;
  try {
    const { data } = await octokit.repos.getContent({
      owner: OWNER,
      repo: REPO,
      path,
      ref: branch,
    });
    sha = data.sha;
  } catch (err) {
    if (err.status !== 404) throw err;
    // File doesn't exist yet — sha stays undefined
  }

  const { data } = await octokit.repos.createOrUpdateFileContents({
    owner: OWNER,
    repo: REPO,
    path,
    message,
    content: btoa(unescape(encodeURIComponent(content))), // base64-encode UTF-8
    sha,
    branch,
  });

  return data;
}

/**
 * Commit multiple files in a single tree commit (batch update).
 *
 * @param {Array<{path: string, content: string}>} files
 * @param {string} message
 * @param {string} token
 * @param {string} [branch]
 */
export async function commitFiles({ files, message, token, branch = DEFAULT_BRANCH }) {
  const octokit = getOctokit(token);

  // 1. Get HEAD commit SHA
  const { data: refData } = await octokit.git.getRef({
    owner: OWNER,
    repo: REPO,
    ref: `heads/${branch}`,
  });
  const headSha = refData.object.sha;

  // 2. Get base tree SHA
  const { data: commitData } = await octokit.git.getCommit({
    owner: OWNER,
    repo: REPO,
    commit_sha: headSha,
  });
  const baseTreeSha = commitData.tree.sha;

  // 3. Create blobs
  const treeItems = await Promise.all(
    files.map(async ({ path, content }) => {
      const { data: blob } = await octokit.git.createBlob({
        owner: OWNER,
        repo: REPO,
        content: btoa(unescape(encodeURIComponent(content))),
        encoding: "base64",
      });
      return { path, mode: "100644", type: "blob", sha: blob.sha };
    }),
  );

  // 4. Create tree
  const { data: tree } = await octokit.git.createTree({
    owner: OWNER,
    repo: REPO,
    tree: treeItems,
    base_tree: baseTreeSha,
  });

  // 5. Create commit
  const { data: newCommit } = await octokit.git.createCommit({
    owner: OWNER,
    repo: REPO,
    message,
    tree: tree.sha,
    parents: [headSha],
  });

  // 6. Update ref
  await octokit.git.updateRef({
    owner: OWNER,
    repo: REPO,
    ref: `heads/${branch}`,
    sha: newCommit.sha,
  });

  return newCommit;
}
