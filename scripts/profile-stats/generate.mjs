#!/usr/bin/env node
/**
 * Génère profile/stats.svg et profile/top-langs.svg à partir de l'API GraphQL GitHub.
 *
 * - Aucune dépendance externe (Node >= 18, fetch natif).
 * - Couvre les repos privés et les contributions aux repos d'autres comptes / organisations,
 *   à condition que le token appartienne au propriétaire du profil (requête sur `viewer`).
 * - Confidentialité : aucun nom de repo n'est écrit dans les SVG ni dans les logs
 *   (les logs d'un dépôt public sont publics). Seuls des agrégats sortent.
 *
 * Variables d'environnement :
 *   PROFILE_STATS_TOKEN  PAT classique (scopes : repo, read:user, read:org)
 *   PROFILE_STATS_MOCK   (optionnel) chemin vers un fixture JSON pour tester le rendu hors ligne
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const OUT_DIR = resolve(ROOT, 'profile');
const config = JSON.parse(await readFile(resolve(HERE, 'config.json'), 'utf8'));

const API = 'https://api.github.com/graphql';
const TOKEN = process.env.PROFILE_STATS_TOKEN;
const MOCK = process.env.PROFILE_STATS_MOCK;

/* ------------------------------------------------------------------ */
/* Accès API                                                           */
/* ------------------------------------------------------------------ */

let partialErrors = 0;

async function gql(query, variables = {}, attempt = 1) {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      Authorization: `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'profile-stats-generator',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 401) {
    throw new Error('Token refusé (401) : PROFILE_STATS_TOKEN est expiré, révoqué ou invalide.');
  }
  if ((res.status >= 500 || res.status === 403 || res.status === 429) && attempt < 4) {
    const wait = Number(res.headers.get('retry-after')) || attempt * 10;
    console.warn(`API GitHub : HTTP ${res.status}, nouvel essai dans ${wait}s (${attempt}/3)`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return gql(query, variables, attempt + 1);
  }
  if (!res.ok) throw new Error(`API GitHub : HTTP ${res.status}`);

  const body = await res.json();
  if (body.errors?.length) {
    if (!body.data) {
      // Message générique : les messages GitHub peuvent contenir des noms d'org ou de repo.
      throw new Error(`Erreur GraphQL (${body.errors.map((e) => e.type ?? 'UNKNOWN').join(', ')})`);
    }
    // Erreurs partielles (ex. org avec SSO SAML non autorisé) : on continue sans ces repos.
    partialErrors += body.errors.length;
  }
  return body.data;
}

const REPO_FIELDS = `
  nameWithOwner
  isPrivate
  isFork
  owner { login }
  languages(first: 20, orderBy: { field: SIZE, direction: DESC }) {
    totalSize
    edges { size node { name color } }
  }`;

const Q_VIEWER = `query { viewer { login createdAt contributionsCollection { contributionYears } } }`;

const Q_YEAR = `
query ($from: DateTime!, $to: DateTime!) {
  viewer {
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      totalPullRequestReviewContributions
      restrictedContributionsCount
      contributionCalendar { totalContributions }
      commitContributionsByRepository(maxRepositories: 100) {
        contributions { totalCount }
        repository { ${REPO_FIELDS} }
      }
      pullRequestContributionsByRepository(maxRepositories: 100) {
        contributions { totalCount }
        repository { ${REPO_FIELDS} }
      }
      issueContributionsByRepository(maxRepositories: 100) {
        repository { nameWithOwner owner { login } }
      }
      pullRequestReviewContributionsByRepository(maxRepositories: 100) {
        repository { nameWithOwner owner { login } }
      }
    }
  }
}`;

const Q_OWNED = `
query ($cursor: String) {
  viewer {
    repositories(first: 100, after: $cursor, ownerAffiliations: OWNER, isFork: false) {
      pageInfo { hasNextPage endCursor }
      nodes { nameWithOwner stargazerCount }
    }
  }
}`;

async function fetchRawData() {
  if (MOCK) return JSON.parse(await readFile(resolve(MOCK), 'utf8'));
  if (!TOKEN) throw new Error('PROFILE_STATS_TOKEN manquant (secret du dépôt).');

  const { viewer } = await gql(Q_VIEWER);
  if (viewer.login.toLowerCase() !== config.username.toLowerCase()) {
    throw new Error('Le token n\'appartient pas au compte configuré : les données privées seraient incomplètes.');
  }

  const years = [];
  for (const year of viewer.contributionsCollection.contributionYears) {
    const data = await gql(Q_YEAR, {
      from: `${year}-01-01T00:00:00Z`,
      to: `${year}-12-31T23:59:59Z`,
    });
    years.push(data.viewer.contributionsCollection);
  }

  const owned = [];
  let cursor = null;
  do {
    const data = await gql(Q_OWNED, { cursor });
    const page = data.viewer.repositories;
    owned.push(...page.nodes.filter(Boolean));
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return { login: viewer.login, years, owned };
}

/* ------------------------------------------------------------------ */
/* Agrégation                                                          */
/* ------------------------------------------------------------------ */

function aggregate({ login, years, owned }) {
  const excluded = new Set(config.exclude_repos.map((r) => r.toLowerCase()));
  const hidden = new Set(config.hide_languages.map((l) => l.toLowerCase()));
  const isExcluded = (repo) => !repo || excluded.has(repo.nameWithOwner.toLowerCase());
  const isExternal = (repo) => repo.owner.login.toLowerCase() !== login.toLowerCase();

  const totals = { contributions: 0, commits: 0, prs: 0, issues: 0, reviews: 0, restricted: 0 };
  const externalRepos = new Set();
  const privateRepos = new Set();
  const weights = new Map(); // nameWithOwner -> { weight, languages }

  const addWeight = (repo, count) => {
    const entry = weights.get(repo.nameWithOwner) ?? { weight: 0, languages: repo.languages };
    entry.weight += count;
    weights.set(repo.nameWithOwner, entry);
  };

  for (const y of years) {
    totals.contributions += y.contributionCalendar.totalContributions;
    totals.commits += y.totalCommitContributions;
    totals.prs += y.totalPullRequestContributions;
    totals.issues += y.totalIssueContributions;
    totals.reviews += y.totalPullRequestReviewContributions;
    totals.restricted += y.restrictedContributionsCount;

    // Pondération des langages : commits + PR de l'utilisateur dans chaque repo.
    for (const list of [y.commitContributionsByRepository, y.pullRequestContributionsByRepository]) {
      for (const { contributions, repository } of list) {
        if (isExcluded(repository)) continue;
        addWeight(repository, contributions.totalCount);
        if (repository.isPrivate) privateRepos.add(repository.nameWithOwner);
      }
    }
    for (const list of [
      y.commitContributionsByRepository,
      y.pullRequestContributionsByRepository,
      y.issueContributionsByRepository,
      y.pullRequestReviewContributionsByRepository,
    ]) {
      for (const { repository } of list) {
        if (!isExcluded(repository) && isExternal(repository)) externalRepos.add(repository.nameWithOwner);
      }
    }
  }

  const stars = owned
    .filter((r) => !isExcluded(r))
    .reduce((sum, r) => sum + r.stargazerCount, 0);

  // Score par langage = somme sur les repos de (poids utilisateur × part du langage dans le repo).
  const scores = new Map();
  for (const { weight, languages } of weights.values()) {
    if (!weight || !languages?.totalSize) continue;
    for (const { size, node } of languages.edges) {
      if (hidden.has(node.name.toLowerCase())) continue;
      const current = scores.get(node.name) ?? { name: node.name, color: node.color, score: 0 };
      current.score += weight * (size / languages.totalSize);
      scores.set(node.name, current);
    }
  }

  const top = [...scores.values()].sort((a, b) => b.score - a.score).slice(0, config.langs_count);
  const topSum = top.reduce((s, l) => s + l.score, 0) || 1;
  const langs = top.map((l) => ({ ...l, percent: (l.score / topSum) * 100 }));

  return {
    stats: {
      ...totals,
      stars,
      externalRepos: externalRepos.size,
      privateRepos: privateRepos.size,
      reposAnalysed: weights.size,
    },
    langs,
  };
}

/* ------------------------------------------------------------------ */
/* Rendu SVG                                                           */
/* ------------------------------------------------------------------ */

const t = config.theme;
const CARD_HEIGHT = 235; // hauteur commune : les deux cartes s'alignent côte à côte
const FONT = "'Segoe UI', Ubuntu, 'Helvetica Neue', Sans-Serif";
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const shorten = (s, max = 16) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const fmt = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : n.toLocaleString('en-US'));

function frame(width, height, title, body) {
  const border = config.hide_border
    ? ''
    : ` stroke="${t.border}" stroke-opacity="1"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title">
  <title id="title">${esc(title)}</title>
  <style>
    .title { font: 600 18px ${FONT}; fill: ${t.title}; }
    .label { font: 600 14px ${FONT}; fill: ${t.text}; }
    .value { font: 700 14px ${FONT}; fill: ${t.text}; }
    .lang  { font: 400 13px ${FONT}; fill: ${t.text}; }
    .note  { font: 400 11px ${FONT}; fill: ${t.muted}; }
  </style>
  <rect x="0.5" y="0.5" rx="4.5" width="${width - 1}" height="${height - 1}" fill="${t.bg}"${border}/>
  <text x="25" y="35" class="title">${esc(title)}</text>
${body}
</svg>
`;
}

function renderStats(s) {
  const rows = [
    ['Total contributions', s.contributions],
    ['Commits', s.commits],
    ['Pull requests', s.prs],
    ['Issues', s.issues],
    ['Code reviews', s.reviews],
    ['External repos contributed to', s.externalRepos],
    ['Stars earned', s.stars],
  ];
  const width = 400;
  const top = 64;
  const step = 23;
  const height = CARD_HEIGHT;
  const body = rows
    .map(([label, value], i) => {
      const y = top + i * step;
      return `  <g transform="translate(25, ${y})">
    <circle cx="6" cy="-5" r="5" fill="${t.icon}"/>
    <text x="22" y="0" class="label">${esc(label)}:</text>
    <text x="${width - 50}" y="0" class="value" text-anchor="end">${fmt(value)}</text>
  </g>`;
    })
    .join('\n');
  const note = `  <text x="25" y="${height - 14}" class="note">Includes private &amp; external repositories</text>`;
  return frame(width, height, config.stats_title, `${body}\n${note}`);
}

function renderLangs(langs) {
  const width = 320;
  const barX = 25;
  const barW = width - 50;
  const barY = 52;
  const height = CARD_HEIGHT;

  let x = barX;
  const segments = langs
    .map((l) => {
      const w = Math.max((l.percent / 100) * barW, 0);
      const seg = `    <rect x="${x.toFixed(2)}" y="${barY}" width="${w.toFixed(2)}" height="8" fill="${l.color ?? '#858585'}"/>`;
      x += w;
      return seg;
    })
    .join('\n');

  const legend = langs
    .map((l, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const lx = barX + col * (barW / 2);
      const ly = barY + 34 + row * 22;
      return `  <g transform="translate(${lx}, ${ly})">
    <circle cx="5" cy="-4" r="5" fill="${l.color ?? '#858585'}"/>
    <text x="16" y="0" class="lang">${esc(shorten(l.name))} ${l.percent.toFixed(1)}%</text>
  </g>`;
    })
    .join('\n');

  const empty = langs.length === 0
    ? `  <text x="25" y="${barY + 30}" class="label">No language data</text>`
    : '';

  const body = `  <defs><clipPath id="bar"><rect x="${barX}" y="${barY}" width="${barW}" height="8" rx="4"/></clipPath></defs>
  <rect x="${barX}" y="${barY}" width="${barW}" height="8" rx="4" fill="${t.track}"/>
  <g clip-path="url(#bar)">
${segments}
  </g>
${legend}${empty}
  <text x="25" y="${height - 12}" class="note">Weighted by own commits &amp; PRs</text>`;
  return frame(width, height, config.langs_title, body);
}

/* ------------------------------------------------------------------ */

try {
  const raw = await fetchRawData();
  const { stats, langs } = aggregate(raw);

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(resolve(OUT_DIR, 'stats.svg'), renderStats(stats));
  await writeFile(resolve(OUT_DIR, 'top-langs.svg'), renderLangs(langs));

  // Agrégats uniquement : jamais de noms de repos dans les logs publics.
  console.log(`Repos analysés : ${stats.reposAnalysed} (dont ${stats.privateRepos} privés, ${stats.externalRepos} externes)`);
  console.log(`Contributions : ${stats.contributions} · Langages retenus : ${langs.length}`);
  if (partialErrors) {
    console.warn(`${partialErrors} élément(s) inaccessibles ignorés (ex. organisation avec SSO SAML : autoriser le token pour cette org).`);
  }
} catch (err) {
  console.error(`Échec de la génération : ${err.message}`);
  process.exit(1);
}
