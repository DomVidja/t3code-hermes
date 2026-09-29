const MINIMUM_RELEASE_GAP_MS = 6 * 60 * 60 * 1000;

function repositoryDefaultBranch(context) {
  const branch = context.payload.repository?.default_branch;
  if (!branch) {
    throw new Error("GitHub did not provide the repository default branch.");
  }
  return branch;
}

async function assertCommitOnDefaultBranch({ github, context, sha }) {
  const defaultBranch = repositoryDefaultBranch(context);
  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo,
    basehead: `${sha}...${defaultBranch}`,
    per_page: 1,
  });
  if (comparison.status !== "ahead" && comparison.status !== "identical") {
    throw new Error(
      `Release commit ${sha} is not contained in ${defaultBranch} (${comparison.status}).`,
    );
  }
}

async function assertReleaseSource({ github, context, releaseChannel }) {
  if (releaseChannel === "preview") return;
  if (releaseChannel !== "stable" && releaseChannel !== "nightly") {
    throw new Error(`Unsupported release channel: ${releaseChannel}`);
  }

  const defaultBranch = repositoryDefaultBranch(context);
  if (context.eventName === "workflow_dispatch" && context.ref !== `refs/heads/${defaultBranch}`) {
    throw new Error(
      `${releaseChannel} releases must be dispatched from ${defaultBranch}; selected ${context.ref}. Use the preview channel for branch builds.`,
    );
  }

  await assertCommitOnDefaultBranch({ github, context, sha: context.sha });
}

const isNightlyTag = (tag) => /^v.*-nightly\./.test(tag) || tag.startsWith("nightly-v");

// Newest published nightly by publication time, or undefined when none exists.
async function findLatestNightly({ github, context }) {
  const releases = await github.paginate(github.rest.repos.listReleases, {
    ...context.repo,
    per_page: 100,
  });
  return releases
    .filter((release) => !release.draft && release.published_at && isNightlyTag(release.tag_name))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
}

// Runs after the workflow acquires the nightly concurrency lock.
async function shouldReleaseNightly({ github, context, core, now = Date.now() }) {
  const lastNightly = await findLatestNightly({ github, context });

  if (!lastNightly) {
    core.info("No published nightly found. Proceeding with release.");
    return true;
  }

  if (now - Date.parse(lastNightly.published_at) < MINIMUM_RELEASE_GAP_MS) {
    core.info(`Nightly ${lastNightly.tag_name} was published less than six hours ago. Skipping.`);
    return false;
  }

  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...context.repo,
    basehead: `${lastNightly.tag_name}...${context.sha}`,
    per_page: 1,
  });
  if (comparison.status !== "ahead") {
    core.info(
      `Candidate commit is ${comparison.status} relative to ${lastNightly.tag_name}. Skipping.`,
    );
    return false;
  }

  core.info(`New commits since ${lastNightly.tag_name}, and the six-hour gap has passed.`);
  return true;
}

const UPSTREAM_REPO = { owner: "pingdotgg", repo: "t3code" };

// Status of `base...head` in this repository, or undefined when GitHub cannot
// resolve `base` here (an upstream commit the fork has not merged yet).
async function compareStatus({ github, context, base, head }) {
  try {
    const { data } = await github.rest.repos.compareCommitsWithBasehead({
      ...context.repo,
      basehead: `${base}...${head}`,
      per_page: 1,
    });
    return data.status;
  } catch (error) {
    if (error.status === 404) return undefined;
    throw error;
  }
}

const contains = (status) => status === "ahead" || status === "identical";

// Fork-only. Fork nightlies follow upstream's: release when the candidate
// commit contains upstream's latest nightly and no fork nightly has shipped it.
// Runs after the workflow acquires the nightly concurrency lock, so a run that
// queued behind one that already shipped this upstream nightly skips.
async function shouldFollowUpstreamNightly({ github, context, core }) {
  const { data: upstreamReleases } = await github.rest.repos.listReleases({
    ...UPSTREAM_REPO,
    per_page: 100,
  });
  const upstreamNightly = upstreamReleases
    .filter((release) => !release.draft && release.published_at && isNightlyTag(release.tag_name))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
  if (!upstreamNightly) {
    core.info("No published upstream nightly found. Skipping.");
    return false;
  }
  const { data: upstreamCommit } = await github.rest.repos.getCommit({
    ...UPSTREAM_REPO,
    ref: upstreamNightly.tag_name,
  });
  const upstreamSha = upstreamCommit.sha;

  if (!contains(await compareStatus({ github, context, base: upstreamSha, head: context.sha }))) {
    core.info(`Upstream ${upstreamNightly.tag_name} (${upstreamSha}) is not merged yet. Skipping.`);
    return false;
  }

  const lastNightly = await findLatestNightly({ github, context });
  if (
    lastNightly &&
    contains(
      await compareStatus({ github, context, base: upstreamSha, head: lastNightly.tag_name }),
    )
  ) {
    core.info(
      `Upstream ${upstreamNightly.tag_name} already shipped in ${lastNightly.tag_name}. Skipping.`,
    );
    return false;
  }

  core.info(`Following upstream ${upstreamNightly.tag_name} (${upstreamSha}).`);
  return true;
}

// Stable releases build the commit the latest nightly shipped, so the stable
// build is one nightly users already ran. Returns the nightly tag, its commit,
// and the stable version that nightly was a preview of.
async function resolveLatestNightlyCommit({ github, context, core }) {
  const lastNightly = await findLatestNightly({ github, context });
  if (!lastNightly) {
    throw new Error("No published nightly found. Stable releases build the latest nightly commit.");
  }

  const tag = lastNightly.tag_name;
  // repos.getCommit dereferences annotated tags, so this is the commit either way.
  const { data: commit } = await github.rest.repos.getCommit({ ...context.repo, ref: tag });
  const version = /^(?:nightly-)?v(\d+\.\d+\.\d+)-nightly\./.exec(tag)?.[1];
  if (!version) {
    throw new Error(`Cannot derive a stable version from nightly tag ${tag}.`);
  }

  core.info(`Latest nightly ${tag} shipped ${commit.sha} as a preview of ${version}.`);
  return { tag, sha: commit.sha, version };
}

module.exports = {
  assertCommitOnDefaultBranch,
  assertReleaseSource,
  shouldReleaseNightly,
  shouldFollowUpstreamNightly,
  resolveLatestNightlyCommit,
};
