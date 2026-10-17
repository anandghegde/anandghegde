#!/usr/bin/env node
// Regenerates README.md from TEMPLATE.md using public GitHub data.
// Needs GITHUB_TOKEN; the daily workflow in .github/workflows runs it.
import { readFile, writeFile } from 'node:fs/promises'

const USER = 'anandghegde'
const TOKEN = process.env.GITHUB_TOKEN
if (!TOKEN) throw new Error('Set GITHUB_TOKEN')

const HEADERS = { Authorization: `bearer ${TOKEN}`, 'User-Agent': USER }
const SINCE = Date.now() - 365 * 24 * 60 * 60 * 1000
const MERGED_QUERY = `author:${USER} is:pr is:merged is:public -user:${USER}`
const TOP_PROJECTS = 20
const PRS_PER_PROJECT = 3
const RECENT_PRS = 8

const num = n => n.toLocaleString('en-US')
const compact = n => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
const escape = text => text.replace(/[\\[\]|<>*]/g, c => `\\${c}`)
const searchUrl = q => `https://github.com/search?type=pullrequests&q=${encodeURIComponent(q)}`

async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ query, variables }),
  })
  const body = await res.json()
  if (!res.ok || body.errors) throw new Error(JSON.stringify(body.errors ?? body))
  return body.data
}

async function fetchProfile() {
  const { user } = await gql(`query($login: String!) {
    user(login: $login) {
      createdAt
      repositories(first: 100, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC) {
        nodes {
          name pushedAt
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name color } } }
        }
      }
      contributionsCollection { totalCommitContributions totalPullRequestContributions totalIssueContributions }
    }
  }`, { login: USER })
  return user
}

// contributionsCollection spans at most one year, so ask for every year since signup in one query.
async function fetchAllTimeCommits(createdAt) {
  const now = new Date()
  const fields = []
  for (let year = new Date(createdAt).getUTCFullYear(); year <= now.getUTCFullYear(); year++) {
    const to = year === now.getUTCFullYear() ? now.toISOString() : `${year}-12-31T23:59:59Z`
    fields.push(`y${year}: contributionsCollection(from: "${year}-01-01T00:00:00Z", to: "${to}") { totalCommitContributions }`)
  }
  const { user } = await gql(`query($login: String!) { user(login: $login) { ${fields.join('\n')} } }`, { login: USER })
  return Object.values(user).reduce((sum, year) => sum + year.totalCommitContributions, 0)
}

async function fetchAllTimeCounts() {
  const data = await gql(`query($prs: String!, $issues: String!) {
    prs: search(type: ISSUE, query: $prs, first: 1) { issueCount }
    issues: search(type: ISSUE, query: $issues, first: 1) { issueCount }
  }`, { prs: `author:${USER} is:pr is:public`, issues: `author:${USER} is:issue is:public` })
  return { prs: data.prs.issueCount, issues: data.issues.issueCount }
}

async function fetchMergedUpstream() {
  const prs = []
  let after = null
  do {
    const { search } = await gql(`query($q: String!, $after: String) {
      search(type: ISSUE, query: $q, first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ... on PullRequest {
          title url mergedAt additions deletions
          repository { nameWithOwner url stargazerCount }
        } }
      }
    }`, { q: MERGED_QUERY, after })
    prs.push(...search.nodes)
    after = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null
  } while (after)
  return prs.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
}

function topLanguages(repos, count = 5) {
  const bytes = new Map()
  for (const repo of repos) {
    for (const { size, node } of repo.languages.edges) {
      const entry = bytes.get(node.name) ?? { size: 0, color: node.color ?? '#555555' }
      entry.size += size
      bytes.set(node.name, entry)
    }
  }
  const total = [...bytes.values()].reduce((sum, entry) => sum + entry.size, 0)
  return [...bytes]
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, count)
    .map(([name, { size, color }]) => {
      const message = encodeURIComponent(`${name} ${Math.round((size / total) * 100)}%`)
      return `![${name}](https://img.shields.io/static/v1?style=flat-square&label=%E2%A0%80&labelColor=${encodeURIComponent(color)}&color=555&message=${message})`
    })
}

function renderStats(columns) {
  const rows = Math.max(...columns.map(column => column.length))
  const lines = ['| All time | Last 12 months | Top languages (last 12 months) |', '|---|---|---|']
  for (let i = 0; i < rows; i++) lines.push(`| ${columns.map(column => column[i] ?? '').join(' | ')} |`)
  return lines.join('\n')
}

function renderUpstream(prs) {
  const byRepo = new Map()
  for (const pr of prs) {
    const name = pr.repository.nameWithOwner
    if (!byRepo.has(name)) byRepo.set(name, { ...pr.repository, prs: [] })
    byRepo.get(name).prs.push(pr)
  }
  const repos = [...byRepo.values()].sort((a, b) => b.stargazerCount - a.stargazerCount)
  const stars = repos.reduce((sum, repo) => sum + repo.stargazerCount, 0)
  const lines = [
    `**${num(prs.length)}** merged PRs in **${num(repos.length)}** projects with a combined **★ ${compact(stars)}**. [See all of them →](${searchUrl(MERGED_QUERY)})`,
    '',
    '| Project | ★ | Merged PRs |',
    '|---|--:|---|',
  ]
  for (const repo of repos.slice(0, TOP_PROJECTS)) {
    const links = repo.prs.slice(0, PRS_PER_PROJECT).map(pr => `[${escape(pr.title)}](${pr.url})`)
    const more = repo.prs.length - PRS_PER_PROJECT
    if (more > 0) links.push(`[+${more} more](${repo.url}/pulls?q=${encodeURIComponent(`is:pr is:merged author:${USER}`)})`)
    lines.push(`| [${repo.nameWithOwner}](${repo.url}) | ${compact(repo.stargazerCount)} | ${links.join('<br>')} |`)
  }
  const rest = repos.slice(TOP_PROJECTS)
  if (rest.length) {
    lines.push(
      '',
      `<details><summary>…and ${rest.length} more projects</summary>`,
      '',
      rest.map(repo => `[${repo.nameWithOwner}](${repo.url}) ★ ${compact(repo.stargazerCount)}`).join(' · '),
      '',
      '</details>',
    )
  }
  return lines.join('\n')
}

function renderRecent(prs) {
  return prs
    .slice(0, RECENT_PRS)
    .map(pr => `- ${pr.mergedAt.slice(0, 10)} · [${pr.repository.nameWithOwner}](${pr.repository.url}): [${escape(pr.title)}](${pr.url})`)
    .join('\n')
}

const profile = await fetchProfile()
const activeRepos = profile.repositories.nodes.filter(repo => Date.parse(repo.pushedAt) >= SINCE)
const [commits, counts, merged] = await Promise.all([
  fetchAllTimeCommits(profile.createdAt),
  fetchAllTimeCounts(),
  fetchMergedUpstream(),
])

// Lines are counted only in merged upstream PRs: own repos include vendored and generated files.
const mergedLastYear = merged.filter(pr => Date.parse(pr.mergedAt) >= SINCE)
const added = mergedLastYear.reduce((sum, pr) => sum + pr.additions, 0)
const removed = mergedLastYear.reduce((sum, pr) => sum + pr.deletions, 0)
const lastYear = profile.contributionsCollection

const stats = renderStats([
  [
    `🔥 **${num(commits)}** commits`,
    `🔀 **${num(counts.prs)}** PRs`,
    `✅ **${num(merged.length)}** PRs merged upstream`,
    `📋 **${num(counts.issues)}** issues`,
  ],
  [
    `🔥 **${num(lastYear.totalCommitContributions)}** commits`,
    `🔀 **${num(lastYear.totalPullRequestContributions)}** PRs`,
    `📋 **${num(lastYear.totalIssueContributions)}** issues`,
    `➕ **${num(added)}** lines added upstream`,
    `➖ **${num(removed)}** lines removed upstream`,
  ],
  topLanguages(activeRepos),
])

// Function replacers, because PR titles can contain `$` sequences that string replacement would expand.
const template = await readFile(new URL('TEMPLATE.md', import.meta.url), 'utf8')
const readme = template
  .replace('{{STATS}}', () => stats)
  .replace('{{UPSTREAM}}', () => renderUpstream(merged))
  .replace('{{RECENT}}', () => renderRecent(merged))
await writeFile(new URL('README.md', import.meta.url), readme)
