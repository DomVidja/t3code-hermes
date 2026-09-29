const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assertCommitOnDefaultBranch,
  assertReleaseSource,
  shouldReleaseNightly,
} = require("./check-nightly-release.cjs");

const now = Date.parse("2026-09-05T12:00:00Z");
const hour = 60 * 60 * 1000;
const nightly = (hoursAgo, overrides = {}) => ({
  tag_name: "v1.0.1-nightly.20260905.123",
  draft: false,
  published_at: new Date(now - hoursAgo * hour).toISOString(),
  ...overrides,
});

function releaseSourceFixture({
  comparisonStatus = "ahead",
  eventName = "workflow_dispatch",
  ref = "refs/heads/main",
  sha = "candidate",
} = {}) {
  const calls = [];
  return {
    calls,
    options: {
      context: {
        eventName,
        payload: { repository: { default_branch: "main" } },
        ref,
        repo: { owner: "example", repo: "app" },
        sha,
      },
      github: {
        rest: {
          repos: {
            async compareCommitsWithBasehead(params) {
              calls.push(params);
              return { data: { status: comparisonStatus } };
            },
          },
        },
      },
    },
  };
}

test("allows preview releases from any branch without consulting main", async () => {
  const { options, calls } = releaseSourceFixture({ ref: "refs/heads/feature" });
  await assertReleaseSource({ ...options, releaseChannel: "preview" });
  assert.equal(calls.length, 0);
});

for (const releaseChannel of ["stable", "nightly"]) {
  test(`rejects a manual ${releaseChannel} release from a feature branch`, async () => {
    const { options, calls } = releaseSourceFixture({ ref: "refs/heads/feature" });
    await assert.rejects(
      assertReleaseSource({ ...options, releaseChannel }),
      new RegExp(`${releaseChannel} releases must be dispatched from main`),
    );
    assert.equal(calls.length, 0);
  });

  test(`allows a manual ${releaseChannel} release from main`, async () => {
    const { options, calls } = releaseSourceFixture();
    await assertReleaseSource({ ...options, releaseChannel });
    assert.equal(calls[0].basehead, "candidate...main");
  });
}

for (const comparisonStatus of ["behind", "diverged"]) {
  test(`rejects a release commit that is ${comparisonStatus} from main`, async () => {
    const { options } = releaseSourceFixture({ comparisonStatus, eventName: "push" });
    await assert.rejects(
      assertCommitOnDefaultBranch({ ...options, sha: "release-commit" }),
      new RegExp(`not contained in main \\(${comparisonStatus}\\)`),
    );
  });
}

test("accepts a release commit already contained in main", async () => {
  for (const comparisonStatus of ["ahead", "identical"]) {
    const { options } = releaseSourceFixture({ comparisonStatus, eventName: "push" });
    await assertCommitOnDefaultBranch({ ...options, sha: "release-commit" });
  }
});

function fixture({ releases = [nightly(7)], comparisonStatus = "ahead" } = {}) {
  const calls = [];
  return {
    calls,
    options: {
      now,
      context: { repo: { owner: "example", repo: "app" }, sha: "new" },
      core: { info() {} },
      github: {
        rest: {
          repos: {
            listReleases() {},
            async compareCommitsWithBasehead(params) {
              calls.push(params);
              return { data: { status: comparisonStatus } };
            },
          },
        },
        async paginate() {
          return releases;
        },
      },
    },
  };
}

test("releases the first nightly when no nightly is published", async () => {
  const { options } = fixture({
    releases: [nightly(0, { tag_name: "v1.0.0" }), nightly(0, { draft: true })],
  });
  assert.equal(await shouldReleaseNightly(options), true);
});

test("waits six hours after publication, including manual nightlies", async () => {
  for (const age of [0, 3, 6 - 1 / 3600]) {
    const { options, calls } = fixture({ releases: [nightly(age)] });
    assert.equal(await shouldReleaseNightly(options), false);
    assert.equal(calls.length, 0);
  }
});

test("releases new commits at six hours and after an idle period", async () => {
  for (const age of [6, 7, 24]) {
    const { options } = fixture({ releases: [nightly(age)] });
    assert.equal(await shouldReleaseNightly(options), true);
  }
});

test("skips unchanged commits after the gap", async () => {
  const { options } = fixture({ comparisonStatus: "identical" });
  assert.equal(await shouldReleaseNightly(options), false);
});

test("uses publication time, not release order or the tagged commit date", async () => {
  const { options } = fixture({
    releases: [nightly(10), nightly(1), nightly(20, { tag_name: "nightly-v0.9.0" })],
  });
  assert.equal(await shouldReleaseNightly(options), false);
});

test("ignores stable releases and drafts when checking the gap", async () => {
  const { options } = fixture({
    releases: [nightly(0, { tag_name: "v1.0.0" }), nightly(0, { draft: true }), nightly(7)],
  });
  assert.equal(await shouldReleaseNightly(options), true);
});

test("compares against the published tag, including legacy nightly tags", async () => {
  const tag = "nightly-v0.9.0";
  const { options, calls } = fixture({ releases: [nightly(7, { tag_name: tag })] });
  assert.equal(await shouldReleaseNightly(options), true);
  assert.equal(calls[0].basehead, `${tag}...new`);
});

test("fails instead of releasing when GitHub cannot supply release state", async () => {
  const { options } = fixture();
  options.github.paginate = async () => {
    throw new Error("GitHub unavailable");
  };
  await assert.rejects(shouldReleaseNightly(options), /GitHub unavailable/);
});

for (const status of ["behind", "diverged"]) {
  test(`skips a candidate commit that is ${status} relative to the last nightly`, async () => {
    const { options } = fixture({ comparisonStatus: status });
    assert.equal(await shouldReleaseNightly(options), false);
  });
}

const { resolveLatestNightlyCommit } = require("./check-nightly-release.cjs");

function nightlyCommitFixture({ releases, commitSha = "abc123" }) {
  const refs = [];
  const { options } = fixture({ releases });
  options.github.rest.repos.getCommit = async ({ ref }) => {
    refs.push(ref);
    return { data: { sha: commitSha } };
  };
  return { options, refs };
}

test("stable releases resolve the commit of the newest published nightly", async () => {
  const { options, refs } = nightlyCommitFixture({
    releases: [
      nightly(10, { tag_name: "v1.0.1-nightly.20260905.100" }),
      nightly(1, { tag_name: "v1.0.1-nightly.20260905.123" }),
      nightly(0, { tag_name: "v1.0.0" }),
      nightly(0, { draft: true, tag_name: "v1.0.1-nightly.20260905.999" }),
    ],
    commitSha: "deadbeef",
  });
  assert.deepEqual(await resolveLatestNightlyCommit(options), {
    tag: "v1.0.1-nightly.20260905.123",
    sha: "deadbeef",
    version: "1.0.1",
  });
  assert.deepEqual(refs, ["v1.0.1-nightly.20260905.123"]);
});

test("stable releases derive the version from legacy nightly tags", async () => {
  const { options } = nightlyCommitFixture({
    releases: [nightly(1, { tag_name: "nightly-v0.9.0-nightly.20260905.5" })],
  });
  assert.equal((await resolveLatestNightlyCommit(options)).version, "0.9.0");
});

test("stable releases fail without a published nightly", async () => {
  const { options } = nightlyCommitFixture({ releases: [nightly(0, { tag_name: "v1.0.0" })] });
  await assert.rejects(resolveLatestNightlyCommit(options), /No published nightly/);
});

const { shouldFollowUpstreamNightly } = require("./check-nightly-release.cjs");

const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });

// `merged` and `shipped` say whether this repo's main and its latest nightly
// contain upstream's nightly commit; "missing" means GitHub cannot resolve it.
function followFixture({
  upstreamReleases = [nightly(1, { tag_name: "v1.0.1-nightly.20260905.200" })],
  forkReleases = [nightly(8, { tag_name: "v1.0.1-nightly.20260905.10" })],
  merged = "ahead",
  shipped = "behind",
} = {}) {
  const calls = [];
  const options = {
    context: { repo: { owner: "fork", repo: "app" }, sha: "main-sha" },
    core: { info() {} },
    github: {
      rest: {
        repos: {
          listReleases() {},
          async getCommit({ owner, ref }) {
            assert.equal(owner, "pingdotgg");
            return { data: { sha: `sha-of-${ref}` } };
          },
          async compareCommitsWithBasehead(params) {
            calls.push(params);
            assert.equal(params.owner, "fork");
            const status = params.basehead.endsWith("...main-sha") ? merged : shipped;
            if (status === "missing") throw notFound();
            return { data: { status } };
          },
        },
      },
      async paginate() {
        return forkReleases;
      },
    },
  };
  options.github.rest.repos.listReleases = async ({ owner }) => {
    assert.equal(owner, "pingdotgg");
    return { data: upstreamReleases };
  };
  return { options, calls };
}

test("follows an upstream nightly that main contains and no fork nightly shipped", async () => {
  const { options, calls } = followFixture();
  assert.equal(await shouldFollowUpstreamNightly(options), true);
  assert.deepEqual(
    calls.map((call) => call.basehead),
    [
      "sha-of-v1.0.1-nightly.20260905.200...main-sha",
      "sha-of-v1.0.1-nightly.20260905.200...v1.0.1-nightly.20260905.10",
    ],
  );
});

test("follows the newest upstream nightly by publication time, ignoring previews", async () => {
  const { options, calls } = followFixture({
    upstreamReleases: [
      nightly(9, { tag_name: "v1.0.1-nightly.20260905.1" }),
      nightly(0, { tag_name: "v1.0.1-preview.20260905.9" }),
      nightly(2, { tag_name: "v1.0.1-nightly.20260905.7" }),
    ],
  });
  assert.equal(await shouldFollowUpstreamNightly(options), true);
  assert.match(calls[0].basehead, /^sha-of-v1\.0\.1-nightly\.20260905\.7\.\.\./);
});

test("skips while the upstream nightly is not merged into main", async () => {
  for (const merged of ["missing", "behind", "diverged"]) {
    const { options, calls } = followFixture({ merged });
    assert.equal(await shouldFollowUpstreamNightly(options), false);
    assert.equal(calls.length, 1);
  }
});

test("skips when a fork nightly already shipped the upstream nightly", async () => {
  for (const shipped of ["ahead", "identical"]) {
    const { options } = followFixture({ shipped });
    assert.equal(await shouldFollowUpstreamNightly(options), false);
  }
});

test("follows without any prior fork nightly", async () => {
  const { options, calls } = followFixture({ forkReleases: [] });
  assert.equal(await shouldFollowUpstreamNightly(options), true);
  assert.equal(calls.length, 1);
});

test("skips when upstream has no published nightly", async () => {
  const { options, calls } = followFixture({
    upstreamReleases: [nightly(0, { tag_name: "v1.0.0" })],
  });
  assert.equal(await shouldFollowUpstreamNightly(options), false);
  assert.equal(calls.length, 0);
});

test("fails instead of releasing when GitHub errors for another reason", async () => {
  const { options } = followFixture();
  options.github.rest.repos.compareCommitsWithBasehead = async () => {
    throw Object.assign(new Error("Server Error"), { status: 500 });
  };
  await assert.rejects(shouldFollowUpstreamNightly(options), /Server Error/);
});
