# The GroupWisdom Slack app

`manifest.json` defines the app: its five bot scopes, the events it listens to, the
`/groupwisdom` command, and the three URLs Slack calls on our server. The code is
`src/slack-hook.ts` (routes), `src/adapters/slack.ts` (rules, tested without the network)
and `src/adapters/slack-client.ts` (the Web API calls). Tests: `npm run test:slack`.

## Creating the app (once)

1. **Create it from the manifest.** At <https://api.slack.com/apps>, choose *Create New App*,
   then *From a manifest*. Pick any workspace you own as the development workspace and paste
   `manifest.json`. Slack will say the events URL could not be verified. That is expected:
   the server does not know the app's signing secret yet.

2. **Give the server its credentials.** On the app's *Basic Information* page, copy these
   into Railway as service variables. Never put them in code.

   | Railway variable        | Where it is in Slack                 |
   |-------------------------|--------------------------------------|
   | `SLACK_CLIENT_ID`       | App Credentials → Client ID          |
   | `SLACK_CLIENT_SECRET`   | App Credentials → Client Secret      |
   | `SLACK_SIGNING_SECRET`  | App Credentials → Signing Secret     |

   Railway restarts the service when variables change. Confirm it is up before step 3.

3. **Verify the events URL.** Under *Event Subscriptions*, press *Retry* next to the request
   URL. It turns green once the server answers Slack's signed check.

4. **Allow other workspaces to install it.** Under *Manage Distribution*, work through the
   checklist and choose *Activate Public Distribution*. The app stays unlisted: only people
   who start the install from `testgroupwisdom.com/slack` can add it.

5. **Try it.** Sign in at `/slack`, tick the consent box, add it to a workspace, then
   `/invite @GroupWisdom` in a public channel. The bot posts a hello within a second or two.
   `/slack/status` reports `"configured": true` once all three variables are set.

## What stays true

- It reads only public channels it has been invited to. It never asks for private channels,
  DMs or files, and refuses channels shared with another company.
- Each channel is its own project, owned by the person who installed the app.
- Raw messages are deleted after 30 days (`GW_SLACK_RETENTION_DAYS`).
- Uninstalling, or disconnecting on `/slack`, deletes every project, message, memory and
  finding from that workspace at once.
- Charging Slack users requires a Slack Marketplace listing: 10 active workspaces, then a
  review of up to about 12 weeks. Until then the app is free and unlisted.
