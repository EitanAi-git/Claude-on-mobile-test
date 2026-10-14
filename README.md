# Cookie Clicker

A cookie clicker game with accounts, cloud saves, a leaderboard and 18 skins.

## Playing

Open the site, create an account (or play as a guest), and click the cookie.
You stay logged in on a device until you press **Log out** in the 👤 account window.

## Accounts and the admin

- The **first account ever created is the admin**, so make yours first.
- Admins see the 🛠️ **Admin** button. Its **Accounts** section lets you set a
  new password for anyone who forgot theirs, make someone else an admin, or
  delete an account.
- **🎛️ Manage** on any account opens that player's panel: add or set cookies,
  give buildings, unlock or remove upgrades, achievements and skins, or wipe
  their bakery. They don't need to be an admin, and the change reaches their
  game within about 30 seconds (or the next time they open it).
- After 10 wrong passwords in a row, an account is locked for 5 minutes.

## How it's hosted (Netlify)

- `public/index.html` is the whole game.
- `netlify/functions/api.mjs` is the server (a Netlify Function) for accounts,
  saves and the leaderboard. Data is stored in Netlify Blobs; nothing to set up.
- `netlify.toml` tells Netlify to publish `public/` and deploy the function.

Connect the GitHub repo in Netlify and every merge to `main` goes live
automatically.

## Running it locally

```sh
npm install
npm run dev     # http://localhost:8888 (accounts are kept in memory)
```
