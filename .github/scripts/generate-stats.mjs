// Generates GitHub stats cards (stats, streak, top languages) as SVG files.
// Runs in GitHub Actions with the built-in GITHUB_TOKEN. No dependencies (Node 20+).
import { writeFile, mkdir, readFile } from "node:fs/promises";

const LOGIN = process.env.USERNAME || "alexandregpereira";
const TOKEN = process.env.GITHUB_TOKEN;
const OUT_DIR = process.env.OUT_DIR || "stats";
const MOCK = process.env.MOCK_DATA; // optional: JSON file with pre-fetched data (local testing)
const TOP_LANGS = 6;

// ---------- GitHub API ----------
async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "profile-stats-generator",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors || json));
  return json.data;
}

async function fetchData() {
  const { user } = await gql(
    `query($login: String!) {
      user(login: $login) {
        name login createdAt
        pullRequests { totalCount }
        issues { totalCount }
        repositoriesContributedTo(first: 1, includeUserRepositories: false,
          contributionTypes: [COMMIT, PULL_REQUEST, ISSUE, PULL_REQUEST_REVIEW]) { totalCount }
      }
    }`,
    { login: LOGIN }
  );

  // Owned, non-fork repositories. With a personal token this includes your private
  // repos (used for languages only; stars/forks are counted on public repos).
  const repos = [];
  let after = null;
  do {
    const data = await gql(
      `query($login: String!, $after: String) {
        user(login: $login) {
          repositories(first: 100, after: $after, ownerAffiliations: OWNER, isFork: false) {
            pageInfo { hasNextPage endCursor }
            nodes {
              isPrivate stargazerCount forkCount
              languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
                edges { size node { name color } }
              }
            }
          }
        }
      }`,
      { login: LOGIN, after }
    );
    const page = data.user.repositories;
    repos.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);

  // Contribution calendar and commit count, one year at a time since the account was
  // created (GitHub only returns up to one year per query). Summing the years gives
  // the all-time commit total. Private contributions are included when the token
  // belongs to you (STATS_TOKEN secret).
  const now = new Date();
  const days = new Map();
  let totalCommits = 0;
  for (let y = new Date(user.createdAt).getUTCFullYear(); y <= now.getUTCFullYear(); y++) {
    const from = new Date(Date.UTC(y, 0, 1));
    const endOfYear = new Date(Date.UTC(y, 11, 31, 23, 59, 59));
    const to = endOfYear < now ? endOfYear : now;
    const data = await gql(
      `query($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) {
          contributionsCollection(from: $from, to: $to) {
            totalCommitContributions
            contributionCalendar { weeks { contributionDays { date contributionCount } } }
          }
        }
      }`,
      { login: LOGIN, from: from.toISOString(), to: to.toISOString() }
    );
    totalCommits += data.user.contributionsCollection.totalCommitContributions;
    for (const w of data.user.contributionsCollection.contributionCalendar.weeks)
      for (const d of w.contributionDays) days.set(d.date, d.contributionCount);
  }

  const langs = {};
  for (const r of repos)
    for (const e of r.languages.edges) {
      langs[e.node.name] ??= { name: e.node.name, color: e.node.color || "#858585", size: 0 };
      langs[e.node.name].size += e.size;
    }

  const publicRepos = repos.filter((r) => !r.isPrivate);
  return {
    name: user.name || user.login,
    stars: publicRepos.reduce((s, r) => s + r.stargazerCount, 0),
    forks: publicRepos.reduce((s, r) => s + r.forkCount, 0),
    totalCommits,
    prs: user.pullRequests.totalCount,
    issues: user.issues.totalCount,
    contributedTo: user.repositoriesContributedTo.totalCount,
    days: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)),
    languages: Object.values(langs),
    today: now.toISOString().slice(0, 10),
  };
}

// ---------- Calculations ----------
function streaks(days, today) {
  days = days.filter(([d]) => d <= today);
  const total = days.reduce((s, [, c]) => s + c, 0);
  const first = days.find(([, c]) => c > 0)?.[0] ?? today;

  let longest = { len: 0, start: null, end: null };
  let run = { len: 0, start: null, end: null };
  for (const [date, count] of days) {
    if (count > 0) {
      if (run.len === 0) run.start = date;
      run.len++;
      run.end = date;
      if (run.len > longest.len) longest = { ...run };
    } else run = { len: 0, start: null, end: null };
  }

  // Current streak: no contributions yet *today* doesn't break it.
  let i = days.length - 1;
  if (i >= 0 && days[i][0] === today && days[i][1] === 0) i--;
  const current = { len: 0, start: today, end: today };
  if (i >= 0 && days[i][1] > 0) {
    current.end = days[i][0];
    while (i >= 0 && days[i][1] > 0) {
      current.len++;
      current.start = days[i][0];
      i--;
    }
  }
  return { total, first, longest, current };
}

// ---------- Rendering ----------
const THEMES = {
  dark: { bg: "#151515", border: "#2a2a2a", title: "#ffffff", text: "#a0a0a0", value: "#d6d6d6", ring: "#e6e6e6", ringBg: "#3a3a3a", accent: "#fb8c00", divider: "#e6e6e6", barBg: "#2a2a2a" },
  light: { bg: "#fffefe", border: "#e4e2e2", title: "#24292f", text: "#57606a", value: "#24292f", ring: "#0969da", ringBg: "#e4e2e2", accent: "#fb8c00", divider: "#d0d7de", barBg: "#eaeef2" },
};
const FONT = `'Segoe UI', Ubuntu, 'Helvetica Neue', Sans-Serif`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (n) => n.toLocaleString("en-US");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(iso, today, withYear = false) {
  const [y, m, d] = iso.split("-").map(Number);
  const showYear = withYear || y !== Number(today.slice(0, 4));
  return `${MONTHS[m - 1]} ${d}${showYear ? `, ${y}` : ""}`;
}
const range = (a, b, today) => (a === b ? fmtDate(a, today) : `${fmtDate(a, today)} - ${fmtDate(b, today)}`);

function card(w, h, t, body, label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">
<title>${esc(label)}</title>
<rect x="0.5" y="0.5" rx="6" width="${w - 1}" height="${h - 1}" fill="${t.bg}" stroke="${t.border}"/>
${body}
</svg>`;
}

function statsCard(d, t) {
  const rows = [
    ["Total Stars Earned", d.stars],
    ["Total Forks", d.forks],
    ["Total Commits", d.totalCommits],
    ["Total PRs", d.prs],
    ["Total Issues", d.issues],
    ["Contributed to", d.contributedTo],
  ];
  const w = 467, h = 60 + rows.length * 26 + 16;
  const rowSvg = rows
    .map(([k, v], i) => {
      const y = 78 + i * 26;
      return `<text x="25" y="${y}" fill="${t.text}" font-size="14" font-weight="600">${k}:</text>
<text x="210" y="${y}" fill="${t.value}" font-size="14" font-weight="700">${num(v)}</text>`;
    })
    .join("\n");
  const cx = 385, cy = 60 + (rows.length * 26) / 2 - 2, r = 44;
  const body = `<g font-family="${FONT}">
<text x="25" y="38" fill="${t.title}" font-size="18" font-weight="700">${esc(d.name)}'s GitHub Stats</text>
${rowSvg}
<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${t.ringBg}" stroke-width="6"/>
<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${t.ring}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${(2 * Math.PI * r * 0.75).toFixed(1)} ${(2 * Math.PI * r).toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>
<text x="${cx}" y="${cy + 2}" text-anchor="middle" fill="${t.title}" font-size="22" font-weight="700">${num(d.stars)}</text>
<text x="${cx}" y="${cy + 22}" text-anchor="middle" fill="${t.text}" font-size="12">★ stars</text>
</g>`;
  return card(w, h, t, body, `${d.name}'s GitHub stats`);
}

function streakCard(s, today, t) {
  const w = 495, h = 195, col = w / 3;
  const c1 = col / 2, c2 = w / 2, c3 = w - col / 2;
  const cur = s.current.len > 0 ? range(s.current.start, s.current.end, today) : fmtDate(today, today);
  const lon = s.longest.len > 0 ? range(s.longest.start, s.longest.end, today) : "—";
  const body = `<g font-family="${FONT}" text-anchor="middle">
<line x1="${col}" y1="28" x2="${col}" y2="170" stroke="${t.divider}"/>
<line x1="${2 * col}" y1="28" x2="${2 * col}" y2="170" stroke="${t.divider}"/>
<text x="${c1}" y="88" fill="${t.title}" font-size="28" font-weight="700">${num(s.total)}</text>
<text x="${c1}" y="120" fill="${t.title}" font-size="14">Total Contributions</text>
<text x="${c1}" y="145" fill="${t.text}" font-size="12">${fmtDate(s.first, today, true)} - Present</text>
<circle cx="${c2}" cy="71" r="40" fill="none" stroke="${t.accent}" stroke-width="5"/>
<path d="M${c2} 20 c 6 5 9 11 7 17 c -2 6 -12 6 -14 0 c -1 -4 1 -7 3 -9 c 0 3 2 4 3 3 c 1 -3 0 -7 1 -11 z" fill="${t.accent}" stroke="${t.bg}" stroke-width="3"/>
<text x="${c2}" y="81" fill="${t.title}" font-size="28" font-weight="700">${num(s.current.len)}</text>
<text x="${c2}" y="140" fill="${t.accent}" font-size="14" font-weight="700">Current Streak</text>
<text x="${c2}" y="164" fill="${t.text}" font-size="12">${cur}</text>
<text x="${c3}" y="88" fill="${t.title}" font-size="28" font-weight="700">${num(s.longest.len)}</text>
<text x="${c3}" y="120" fill="${t.title}" font-size="14">Longest Streak</text>
<text x="${c3}" y="145" fill="${t.text}" font-size="12">${lon}</text>
</g>`;
  return card(w, h, t, body, "GitHub contribution streak");
}

function langsCard(languages, t) {
  const total = languages.reduce((s, l) => s + l.size, 0) || 1;
  const top = [...languages].sort((a, b) => b.size - a.size).slice(0, TOP_LANGS);
  const topTotal = top.reduce((s, l) => s + l.size, 0) || 1;
  const w = 350, barX = 25, barW = 300, rowsN = Math.ceil(top.length / 2);
  const h = 95 + rowsN * 25;
  let x = barX;
  const segs = top
    .map((l) => {
      const segW = (l.size / topTotal) * barW;
      const s = `<rect x="${x.toFixed(2)}" y="55" width="${segW.toFixed(2)}" height="8" fill="${l.color}"/>`;
      x += segW;
      return s;
    })
    .join("");
  const items = top
    .map((l, i) => {
      const cx = i % 2 === 0 ? 25 : 190, y = 92 + Math.floor(i / 2) * 25;
      return `<circle cx="${cx + 5}" cy="${y - 4}" r="5" fill="${l.color}"/>
<text x="${cx + 16}" y="${y}" fill="${t.text}" font-size="12">${esc(l.name)} ${((l.size / total) * 100).toFixed(2)}%</text>`;
    })
    .join("\n");
  const body = `<g font-family="${FONT}">
<text x="25" y="38" fill="${t.title}" font-size="18" font-weight="700">Most Used Languages</text>
<clipPath id="bar"><rect x="${barX}" y="55" width="${barW}" height="8" rx="4"/></clipPath>
<rect x="${barX}" y="55" width="${barW}" height="8" rx="4" fill="${t.barBg}"/>
<g clip-path="url(#bar)">${segs}</g>
${items}
</g>`;
  return card(w, h, t, body, "Most used languages");
}

// ---------- Main ----------
const data = MOCK ? JSON.parse(await readFile(MOCK, "utf8")) : await fetchData();
const s = streaks(data.days, data.today);
await mkdir(OUT_DIR, { recursive: true });
for (const [name, theme] of Object.entries(THEMES)) {
  await writeFile(`${OUT_DIR}/stats-${name}.svg`, statsCard(data, theme));
  await writeFile(`${OUT_DIR}/streak-${name}.svg`, streakCard(s, data.today, theme));
  await writeFile(`${OUT_DIR}/langs-${name}.svg`, langsCard(data.languages, theme));
}
console.log(`Stars ${data.stars}, forks ${data.forks}, contributions ${s.total}, current streak ${s.current.len}, longest ${s.longest.len}`);
