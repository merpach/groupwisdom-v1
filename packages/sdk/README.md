# @groupwisdom/sdk

Official JavaScript / TypeScript client for the [GroupWisdom API](https://testgroupwisdom.com/docs.html).

GroupWisdom reads what a group has shared and returns findings none of them
reached alone. Most of the time it returns nothing, which is the intended
result — see [How the engine works](https://testgroupwisdom.com/docs.html#how-it-works).

```bash
npm install @groupwisdom/sdk
```

## Quick start

```ts
import GroupWisdom from '@groupwisdom/sdk'

const gw = new GroupWisdom({ apiKey: process.env.GROUPWISDOM_API_KEY })

const project = await gw.createProject('my-project')

await gw.ingest(project.id, {
  title: 'Q3 user research findings',
  content: 'Users in APAC want offline mode…',
  contributed_by: 'Sarah',        // attribution is what makes findings useful
})

const { data } = await gw.listWisdom(project.id)
for (const w of data) console.log(w.title, '—', w.body)
```

`listWisdom` is paginated: it returns `{ data, total, limit, offset, has_more }`,
so iterate `data` rather than the result itself.

## Pointing at another host

The default base URL is the hosted API. Override it to run against your own
deployment:

```ts
new GroupWisdom({ apiKey, baseUrl: 'https://your-host.example.com' })
```

## Reading the engine's own account of itself

Most batches produce nothing, on purpose. Every such decision is recorded
with its reason, and the memory the engine reasons from is readable too:

```ts
const records = await gw.getGateRecords(project.id, { limit: 5 })
for (const r of records) console.log(r.stage, r.verdict, r.reason)

const { memory } = await gw.getMemory(project.id)   // purpose, facts, decisions, open questions
const usage = await gw.getUsage()                    // percent_used, limit_reached
```

Also in 0.4.0: `analyze`, `deleteProject`, `testWebhook`, `giveFeedback`,
`withdrawFeedback`, `listFeedback`, `renameContributor`, and `stated_in`
and `channel` on the full wisdom shape.

## Notes

- Zero runtime dependencies. Full TypeScript types are included.
- `listInsights` is the former name for `listWisdom` and still works.
- Getting your API key: sign in with Google on the [account page](https://testgroupwisdom.com/account) and it is on the first screen.

Full reference, including webhooks, channel scoping, and the endpoints for
inspecting what the engine has understood: **https://testgroupwisdom.com/docs.html**
