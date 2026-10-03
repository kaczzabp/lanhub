
# Lanhub

  

A self-hosted hub for LAN parties. Run it on one machine, hand out guest codes, and everyone on the network gets the same page: chat, polls, a checklist, a food menu with ordering, download links, and announcements. No internet, no accounts, no cloud - everything stays on the LAN.

  

---

  

## Features

  

### For guests

  

-  **Guest codes** - log in with a short code, no account or email needed.

-  **Live chat** - real-time group chat over WebSockets, with flood control and message history.

-  **Polls** - one vote per person, results update live as they come in.

-  **Checklist** - a shared list (food order, bring-list, tournaments) that everyone ticks off independently. A matrix view shows who ticked what.

-  **Links and downloads** - grab installers, drivers, or pinned URLs without hunting through chat.

-  **Food menu and ordering** - browse the menu, pick what you want, and the host sees every order with prices and totals.

-  **Announcements** - a banner pinned across the top, dismissible per person.

-  **Online now** - the sidebar shows who is currently connected.

  

### For the host

  

-  **Admin panel** - separate password, never visible to guests.

-  **Guest codes** - generate codes with optional seat number and game handle, revoke them, and see who is online at a glance.

-  **Poll management** - create, close, reopen, and delete polls.

-  **Menu builder** - build a menu with sections and prices, open and close ordering, and view orders per person with totals plus an aggregated count for the kitchen.

-  **Clock mode** - turns every connected screen into a giant clock showing the current announcement and a welcome message. Made for the projector or the TV across the room.

-  **Section toggles** - hide any section (links, chat, polls, checklist, menu) from everyone with one click.

-  **Links and uploads** - pin URLs or upload files up to 2 GB each, reorder them, remove them.

  

### Under the hood

  

-  **Three ways in** - the server answers mDNS (`lan.local`), LLMNR (`lan`, Windows), and plain IP, all at the same time.

-  **HTTPS included** - a local CA and server certificate are generated on first run and served on port 443 alongside HTTP.

-  **Discord event log (optional)** - point it at a webhook and get embeds for logins, generated codes, poll activity, and announcements.

-  **Hardened by default** - rate-limited logins, timing-safe password comparison, in-memory sessions that expire after 24 hours.

-  **Live console** - the terminal shows the LAN address, the admin password, and a live online counter.

  

---

  

## Quick start

  

Requirements: Node.js 18 or newer.

  

```bash

git  clone  https://github.com/kaczzabp/lanhub.git

cd  lanhub

npm  install

node  server.js

```

  

On first run the admin password is generated and printed to the console, along with the LAN address. Open that address on any machine on the same network and log in as host.

  

**First party:**

  

1. Log in with the printed password under HOST LOGIN.

2. Open the admin panel (top right).

3. Generate a guest code for each person and hand them out.

4. Guests enter their code on the login screen - done.

  

---

  

## Configuration

  

All settings are optional. Copy `.env.example` to `.env` and change what you need; the file is loaded automatically at startup. Anything left unset gets a sensible default, and generated values are printed to the console.

  

| Variable | Default | Description |

| --- | --- | --- |

| `PORT` | `80` | HTTP port |

| `HTTPS_PORT` | `443` | HTTPS port, served alongside HTTP |

| `ADMIN_PASSWORD` | random, printed once | Password for the host login |

| `SESSION_SECRET` | random | Session signing key |

| `MDNS_NAME` | `lan` | Hostname advertised as `<name>.local` |

| `DISCORD_WEBHOOK_URL` | unset | Discord webhook for server event logging |

  

---

  

## Accessing the hub

  

Guests can use whichever of these works on their device, in order of preference:

  

| URL | How it resolves | Works on |

| --- | --- | --- |

| `http://lan.local` | mDNS | Windows 10/11, macOS, iOS, Linux. Android usually cannot resolve `.local` at all. |

| `http://lan` | LLMNR | Windows only. The server answers queries on UDP 5355. |

| `http://<server-ip>` | Plain IP | Always works, nothing to configure. |

  

### HTTPS

  

The server also listens on port 443. Certificates come from a local CA generated on first run and stored in `data/certs/`. The CA is valid for 10 years, the server certificate for 825 days, and it is re-issued automatically if the server's IP or hostname changes.

  

Browsers show a warning until the CA is trusted on the device. Install it once by opening `http://lan.local/ca.crt` (or copy the file over), and `https://lan.local` works without warnings afterwards. HTTP keeps working in parallel either way.

  

If port 443 is busy or unavailable, HTTPS is skipped and HTTP carries on unaffected.

  

---

  

## Troubleshooting name resolution

  

If `lan.local` does not resolve from a guest machine:

  

- Run `ipconfig /flushdns` on the guest and retry. A negative result cached while the server was off can persist for a while.

- Bulletproof fallback: pin the name in the guest's hosts file (run as Administrator on the guest). This works even when the router filters multicast:

  

```powershell

Add-Content C:\Windows\System32\drivers\etc\hosts "192.168.0.233 lan.local"

```

  

- On a fresh server machine, Windows blocks the needed ports by default. Allow them once (as Administrator on the server):

  

```powershell

New-NetFirewallRule -DisplayName "lanhub" -Direction Inbound -Action Allow -Profile Any -Protocol TCP -LocalPort 80,443

New-NetFirewallRule -DisplayName "lanhub (mDNS+LLMNR)" -Direction Inbound -Action Allow -Profile Any -Protocol UDP -LocalPort 5353,5355

```

  

- Check the router: disable AP/client isolation, and if present, IGMP snooping or multicast filtering. Those block mDNS and LLMNR between Wi-Fi and Ethernet.

- Renaming `.local` to something else does not help - Windows only sends mDNS queries for `.local` names. The LLMNR name (`http://lan`) can be changed through `MDNS_NAME`, since both come from the same setting.

  

---

  

## Resetting data

  

Stop the server and delete `data/db.json`. It is recreated with empty defaults on the next start. Uploaded files live in `uploads/` and can be cleared the same way.

  

---

  

## Project structure

  

```

lanhub/

|-- public/

| |-- index.html # single-page app

| |-- css/style.css

| |-- js/app.js

| |-- lang.json # all interface strings, editable

| |-- fonts/ # optional local fonts, see below

| `-- vendor/ # bundled socket.io client (no CDN)

|-- data/

| |-- db.json # runtime data (gitignored)

| `-- certs/ # generated CA and server certificates (gitignored)

|-- uploads/ # uploaded files (gitignored)

|-- server.js # express + socket.io backend

|-- .env.example

`-- package.json

```

  

The database and uploads directory are created automatically on first run and are excluded from git.

  

---

  

## Fonts

  

The app falls back to system fonts by default. For the intended look, download these two fonts, place the `.woff2` files in `public/fonts/`, and uncomment the `@font-face` rules in `public/fonts/fonts.css`:

  

- [Share Tech Mono](https://fonts.google.com/specimen/Share+Tech+Mono)

- [Inter](https://fonts.google.com/specimen/Inter)

  

---

  

## Notes

  

- Everything runs on the local network. Nothing is sent to the internet - the only optional outbound call is the Discord webhook, if you configure one.

- The socket.io client is bundled in `public/vendor/`, so the page loads even when there is no uplink.

- Sessions are in-memory. Restarting the server logs everyone out; data survives.

- All interface text lives in `public/lang.json`, so every label and message can be edited or translated in one place.

-  `lan.local` works out of the box on Linux and macOS. Windows guests may need [Bonjour](https://support.apple.com/downloads/bonjour) installed, or can use `http://lan` or the IP instead.

- Not designed for production or public internet exposure. Keep it on the LAN.

- The 'Food ordering' is just a centralized Menu where the host or the person who orders the food gets to see it in one place and doesn't have to go around asking people

  

---

  

## License

  

[MIT](LICENSE)