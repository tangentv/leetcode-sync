const axios = require("axios");
const { Octokit } = require("@octokit/rest");
const path = require("path");

const COMMIT_MESSAGE = "Sync LeetCode submission";
const LANG_TO_EXTENSION = {
  bash: "sh",
  c: "c",
  cpp: "cpp",
  csharp: "cs",
  dart: "dart",
  elixir: "ex",
  erlang: "erl",
  golang: "go",
  java: "java",
  javascript: "js",
  kotlin: "kt",
  mssql: "sql",
  mysql: "sql",
  oraclesql: "sql",
  php: "php",
  python: "py",
  python3: "py",
  pythondata: "py",
  postgresql: "sql",
  racket: "rkt",
  ruby: "rb",
  rust: "rs",
  scala: "scala",
  swift: "swift",
  typescript: "ts",
};
const BASE_URL = "https://leetcode.com";

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

function log(message) {
  console.log(`[${new Date().toUTCString()}] ${message}`);
}

function pad(n) {
  if (n.length > 4) {
    return n;
  }
  var s = "000" + n;
  return s.substring(s.length - 4);
}

function normalizeName(problemName) {
  return problemName
    .toLowerCase()
    .replace(/\s/g, "-")
    .replace(/[^a-zA-Z0-9_-]/gi, "");
}

function graphqlHeaders(session, csrfToken) {
  return {
    "content-type": "application/json",
    origin: BASE_URL,
    referer: BASE_URL,
    cookie: `csrftoken=${csrfToken}; LEETCODE_SESSION=${session};`,
    "x-csrftoken": csrfToken,
  };
}

async function getInfo(submission, session, csrfToken) {
  let data = JSON.stringify({
    query: `query submissionDetails($submissionId: Int!) {
      submissionDetails(submissionId: $submissionId) {
        runtime
        runtimeDisplay
        runtimePercentile
        memory
        memoryDisplay
        memoryPercentile
        code
        timestamp
        statusCode
        statusDisplay
        lang {
          name
          verboseName
        }
        question {
          questionId
          title
          titleSlug
          content
          difficulty
        }
      }
    }`,
    variables: { submissionId: Number(submission.id) },
  });

  const headers = graphqlHeaders(session, csrfToken);

  const getSubmissionInfo = async (maxRetries = 5, retryCount = 0) => {
    try {
      const response = await axios.post(
        "https://leetcode.com/graphql/",
        data,
        { headers }
      );

      const submissionDetails =
        response.data?.data?.submissionDetails;

      if (!submissionDetails) {
        console.error(
          "Unexpected LeetCode submissionDetails response:"
        );
        console.error(
          JSON.stringify(response.data, null, 2)
        );

        throw new Error(
          `Unable to get details for submission #${submission.id}`
        );
      }

      const runtimePercentile =
        submissionDetails.runtimePercentile !== null &&
        submissionDetails.runtimePercentile !== undefined
          ? `${submissionDetails.runtimePercentile.toFixed(2)}%`
          : "N/A";

      const memoryPercentile =
        submissionDetails.memoryPercentile !== null &&
        submissionDetails.memoryPercentile !== undefined
          ? `${submissionDetails.memoryPercentile.toFixed(2)}%`
          : "N/A";

      const questionId = submissionDetails?.question?.questionId
        ? pad(submissionDetails.question.questionId.toString())
        : "N/A";

      const lang =
        submissionDetails?.lang?.name ||
        submissionDetails?.lang?.verboseName ||
        submission.lang;

      log(`Got info for submission #${submission.id}`);

      return {
        ...submission,
        title: submissionDetails.question?.title || submission.title,
        titleSlug:
          submissionDetails.question?.titleSlug || submission.titleSlug,
        lang,
        runtime:
          submissionDetails.runtime ??
          submission.runtime ??
          "N/A",
        memory:
          submissionDetails.memory ??
          submission.memory ??
          "N/A",
        statusDisplay:
          submissionDetails.statusDisplay ||
          submission.statusDisplay ||
          "Accepted",
        timestamp:
          submissionDetails.timestamp ||
          submission.timestamp,
        runtimePerc: runtimePercentile,
        memoryPerc: memoryPercentile,
        qid: questionId,
        code: submissionDetails.code,
      };
    } catch (exception) {
      if (retryCount >= maxRetries) {
        if (
          exception.response &&
          exception.response.status === 403
        ) {
          log(`Skipping locked problem: ${submission.title}`);
          return null;
        }

        throw exception;
      }

      log(
        "Error fetching submission info, retrying in " +
          3 ** retryCount +
          " seconds..."
      );

      await delay(3 ** retryCount * 1000);

      return getSubmissionInfo(
        maxRetries,
        retryCount + 1
      );
    }
  };

  return await getSubmissionInfo();
}

async function commit(params) {
  const {
    octokit,
    owner,
    repo,
    defaultBranch,
    commitInfo,
    treeSHA,
    latestCommitSHA,
    submission,
    destinationFolder,
    commitHeader,
    questionData,
  } = params;

  const name = normalizeName(submission.title);
  log(`Committing solution for ${name}...`);

  if (!LANG_TO_EXTENSION[submission.lang]) {
    throw `Language ${submission.lang} does not have a registered extension.`;
  }

  const prefix = !!destinationFolder ? destinationFolder : "";
  const commitName = !!commitHeader ? commitHeader : COMMIT_MESSAGE;

  if ("runtimePerc" in submission) {
    message = `${commitName} - ${submission.title} - Runtime - ${submission.runtime} (${submission.runtimePerc}), Memory - ${submission.memory} (${submission.memoryPerc})`;
    qid = `${submission.qid}-`;
  } else {
    message = `${commitName} - ${submission.title} - Runtime - ${submission.runtime}, Memory - ${submission.memory}`;
    qid = "";
  }
  const folderName = `${qid}${name}`;
  // Markdown file for the problem with question data
  const questionPath = path.join(prefix, folderName, "README.md");

  // Separate file for the solution
  const solutionFileName = `solution.${LANG_TO_EXTENSION[submission.lang]}`;
  const solutionPath = path.join(prefix, folderName, solutionFileName);

  const treeData = [
    {
      path: path.normalize(questionPath),
      mode: "100644",
      content: questionData ?? "Unable to fetch the Problem statement.",
    },
    {
      path: path.normalize(solutionPath),
      mode: "100644",
      content: `${submission.code}\n`, // Adds newline at EOF to conform to git recommendations
    },
  ];

  const treeResponse = await octokit.git.createTree({
    owner: owner,
    repo: repo,
    base_tree: treeSHA,
    tree: treeData,
  });

  const date = new Date(Number(submission.timestamp) * 1000).toISOString();
  const commitResponse = await octokit.git.createCommit({
    owner: owner,
    repo: repo,
    message: message,
    tree: treeResponse.data.sha,
    parents: [latestCommitSHA],
    author: {
      email: commitInfo.email,
      name: commitInfo.name,
      date: date,
    },
    committer: {
      email: commitInfo.email,
      name: commitInfo.name,
      date: date,
    },
  });

  await octokit.git.updateRef({
    owner: owner,
    repo: repo,
    sha: commitResponse.data.sha,
    ref: "heads/" + defaultBranch,
    force: true,
  });

  log(`Committed solution for ${name}`);

  return [treeResponse.data.sha, commitResponse.data.sha];
}

async function getQuestionData(titleSlug, leetcodeSession, csrfToken) {
  log(`Getting question data for ${titleSlug}...`);

  const headers = graphqlHeaders(leetcodeSession, csrfToken);
  const graphql = JSON.stringify({
    query: `query getQuestionDetail($titleSlug: String!) {
      question(titleSlug: $titleSlug) {
        content
      }
    }`,
    variables: { titleSlug: titleSlug },
  });

  try {
    const response = await axios.post(
      "https://leetcode.com/graphql/",
      graphql,
      { headers }
    );
    const result = await response.data;
    return result.data.question.content;
  } catch (error) {
    // If problem is locked due to user not having LeetCode Premium
    if (error.response && error.response.status === 403) {
      log(`Skipping locked problem: ${titleSlug}`);
      return null;
    }
    console.log("error", error);
  }
}

// Returns false if no more submissions should be added.
// Returns false if no more submissions should be added.
// Adds accepted submissions to the sync list.
function addToSubmissions(params) {
  const {
    response,
    lastTimestamp,
    filterDuplicateSecs,
    submissions_dict,
    submissions,
  } = params;

  const recentSubmissions =
    response.data?.data?.recentAcSubmissionList;

  if (!Array.isArray(recentSubmissions)) {
    console.error(
      "Unexpected LeetCode response: recentAcSubmissionList is not an array."
    );

    console.error(
      JSON.stringify(response.data, null, 2)
    );

    throw new Error(
      "LeetCode recentAcSubmissionList is not available."
    );
  }

  for (const submission of recentSubmissions) {
    const submissionTimestamp =
      Number(submission.timestamp);

    if (submissionTimestamp <= lastTimestamp) {
      continue;
    }

    const name = normalizeName(submission.title);

    // recentAcSubmissionList already contains only
    // accepted submissions.
    const lang = submission.lang || "unknown";

    if (!submissions_dict[name]) {
      submissions_dict[name] = {};
    }

    if (
      submissions_dict[name][lang] &&
      submissions_dict[name][lang] - submissionTimestamp <
        filterDuplicateSecs
    ) {
      continue;
    }

    submissions_dict[name][lang] =
      submissionTimestamp;

    submissions.push({
      ...submission,
      statusDisplay: "Accepted",
    });
  }

  return true;
}

async function getLeetCodeUsername(
  leetcodeSession,
  csrfToken
) {
  const headers = graphqlHeaders(
    leetcodeSession,
    csrfToken
  );

  const graphql = JSON.stringify({
    query: `query {
      userStatus {
        isSignedIn
        username
      }
    }`,
  });

  const response = await axios.post(
    "https://leetcode.com/graphql/",
    graphql,
    { headers }
  );

  const userStatus =
    response.data?.data?.userStatus;

  if (!userStatus?.isSignedIn || !userStatus?.username) {
    throw new Error(
      "Unable to determine LeetCode username. Your LEETCODE_SESSION may be expired."
    );
  }

  log(
    `Authenticated as LeetCode user: ${userStatus.username}`
  );

  return userStatus.username;
}

async function getRecentAcceptedSubmissions(
  username,
  leetcodeSession,
  csrfToken
) {
  const headers = graphqlHeaders(
    leetcodeSession,
    csrfToken
  );

  const graphql = JSON.stringify({
    query: `query recentAcSubmissions(
      $username: String!,
      $limit: Int!
    ) {
      recentAcSubmissionList(
        username: $username,
        limit: $limit
      ) {
        id
        title
        titleSlug
        timestamp
      }
    }`,
    variables: {
      username,
      limit: 20,
    },
  });

  const response = await axios.post(
    "https://leetcode.com/graphql/",
    graphql,
    { headers }
  );

  const submissions =
    response.data?.data?.recentAcSubmissionList;

  if (!Array.isArray(submissions)) {
    console.error(
      "Unexpected recentAcSubmissionList response:"
    );

    console.error(
      JSON.stringify(response.data, null, 2)
    );

    throw new Error(
      "LeetCode recentAcSubmissionList did not return an array."
    );
  }

  log(
    `Found ${submissions.length} recent accepted submissions.`
  );

  return response;
}

async function getLeetCodeUsername(
  leetcodeSession,
  csrfToken
) {
  const headers = graphqlHeaders(
    leetcodeSession,
    csrfToken
  );

  const graphql = JSON.stringify({
    query: `query {
      userStatus {
        isSignedIn
        username
      }
    }`,
  });

  const response = await axios.post(
    "https://leetcode.com/graphql/",
    graphql,
    { headers }
  );

  const userStatus =
    response.data?.data?.userStatus;

  if (!userStatus?.isSignedIn || !userStatus?.username) {
    throw new Error(
      "Unable to determine LeetCode username. Your LEETCODE_SESSION may be expired."
    );
  }

  log(
    `Authenticated as LeetCode user: ${userStatus.username}`
  );

  return userStatus.username;
}

async function getRecentAcceptedSubmissions(
  username,
  leetcodeSession,
  csrfToken
) {
  const headers = graphqlHeaders(
    leetcodeSession,
    csrfToken
  );

  const graphql = JSON.stringify({
    query: `query recentAcSubmissions(
      $username: String!,
      $limit: Int!
    ) {
      recentAcSubmissionList(
        username: $username,
        limit: $limit
      ) {
        id
        title
        titleSlug
        timestamp
      }
    }`,
    variables: {
      username,
      limit: 20,
    },
  });

  const response = await axios.post(
    "https://leetcode.com/graphql/",
    graphql,
    { headers }
  );

  const submissions =
    response.data?.data?.recentAcSubmissionList;

  if (!Array.isArray(submissions)) {
    console.error(
      "Unexpected recentAcSubmissionList response:"
    );

    console.error(
      JSON.stringify(response.data, null, 2)
    );

    throw new Error(
      "LeetCode recentAcSubmissionList did not return an array."
    );
  }

  log(
    `Found ${submissions.length} recent accepted submissions.`
  );

  return response;
}

async function sync(inputs) {
  const {
    githubToken,
    owner,
    repo,
    leetcodeCSRFToken,
    leetcodeSession,
    filterDuplicateSecs,
    destinationFolder,
    verbose,
    commitHeader,
  } = inputs;

  const octokit = new Octokit({
    auth: githubToken,
    userAgent: "LeetCode sync to GitHub - GitHub Action",
  });
  // First, get the time the timestamp for when the syncer last ran.
  const commits = await octokit.repos.listCommits({
    owner: owner,
    repo: repo,
    per_page: 100,
  });

  let lastTimestamp = 0;
  // commitInfo is used to get the original name / email to use for the author / committer.
  // Since we need to modify the commit time, we can't use the default settings for the
  // authenticated user.
  let commitInfo = commits.data[commits.data.length - 1].commit.author;
  for (const commit of commits.data) {
    if (
      !commit.commit.message.startsWith(
        !!commitHeader ? commitHeader : COMMIT_MESSAGE
      )
    ) {
      continue;
    }
    commitInfo = commit.commit.author;
    lastTimestamp = Date.parse(commit.commit.committer.date) / 1000;
    break;
  }

  // Get all Accepted submissions from LeetCode greater than the timestamp.
  // Get recent Accepted submissions from LeetCode.
const submissions = [];
const submissions_dict = {};

log("Getting LeetCode username...");

const username = await getLeetCodeUsername(
  leetcodeSession,
  leetcodeCSRFToken
);

log(`Getting recent accepted submissions for ${username}...`);

const response = await getRecentAcceptedSubmissions(
  username,
  leetcodeSession,
  leetcodeCSRFToken
);

addToSubmissions({
  response,
  lastTimestamp,
  filterDuplicateSecs,
  submissions_dict,
  submissions,
});
  // We have all submissions we want to write to GitHub now.
  // First, get the default branch to write to.
  const repoInfo = await octokit.repos.get({
    owner: owner,
    repo: repo,
  });
  const defaultBranch = repoInfo.data.default_branch;
  log(`Default branch for ${owner}/${repo}: ${defaultBranch}`);
  // Write in reverse order (oldest first), so that if there's errors, the last sync time
  // is still valid.
  log(`Syncing ${submissions.length} submissions...`);
  let latestCommitSHA = commits.data[0].sha;
  let treeSHA = commits.data[0].commit.tree.sha;
  for (i = submissions.length - 1; i >= 0; i--) {
    submission = await getInfo(
      submissions[i],
      leetcodeSession,
      leetcodeCSRFToken
    );

    if (submission === null) {
      // Skip this submission if it is null (locked problem)
      continue;
    }

    // Get the question data for the submission.
    const questionData = await getQuestionData(
      submission.titleSlug,
      leetcodeSession,
      leetcodeCSRFToken
    );
    if (questionData === null) {
      // Skip this submission if question data is null (locked problem)
      continue;
    }
    [treeSHA, latestCommitSHA] = await commit({
      octokit,
      owner,
      repo,
      defaultBranch,
      commitInfo,
      treeSHA,
      latestCommitSHA,
      submission,
      destinationFolder,
      commitHeader,
      questionData,
    });
  }
  log("Done syncing all submissions.");
}

module.exports = { log, sync };
