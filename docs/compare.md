# vauly, 1Password and Bitwarden

vauly is for teams of two to a handful who want their passwords and keys on an account they own, without a server to run. 1Password and Bitwarden do much more, and both have years of independent audits behind them; vauly is younger and smaller. This page puts the three side by side so you can choose. What it says about 1Password and Bitwarden comes from their own pages, checked in October 2026.

## At a glance

|                                | vauly                                                                                                            | 1Password                                                                           | Bitwarden                                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Where your vault lives         | Your own Cloudflare account                                                                                      | 1Password's cloud, in the US, Canada or the EU                                      | Bitwarden's cloud, or a server you run                                                                             |
| A server to look after         | None: Cloudflare runs the Worker and its database                                                                | None                                                                                | When you self-host: Docker, at least 2 GB of memory, and its updates                                               |
| Source code                    | Open, AGPL-3.0                                                                                                   | Closed                                                                              | Open: the server is AGPL-3.0 and the apps GPL-3.0, with SSO and some business features under the Bitwarden License |
| What a team of five pays       | Nothing: a small team fits in Cloudflare's free plan                                                             | $24.95 a month on Teams Starter Pack, for up to 10 people                           | $20 a month on Teams; self-hosting needs Enterprise, at $30 a month. Two people can use it free.                   |
| Encrypted on your device       | Yes: Argon2id and AES-256-GCM                                                                                    | Yes: your account password and a Secret Key, and AES-256                            | Yes: PBKDF2 or Argon2id, and AES-256                                                                               |
| Secrets for scripts and agents | `vauly run`, included; a person approves each item once                                                          | `op run` and service accounts, included                                             | `bws run`, part of Secrets Manager, a separate product                                                             |
| Apps                           | A web app that works on phones and installs as an app, an extension for Chromium browsers and Firefox, and a CLI | Apps for Mac, Windows, Linux, iOS and Android, and extensions for the main browsers | Apps for Mac, Windows, Linux, iOS and Android, extensions for nine browsers, and a CLI                             |
| Passkeys                       | Saved and used by the extension, in Chromium browsers and Firefox                                                | Yes                                                                                 | Yes                                                                                                                |
| Independent security audits    | Not yet                                                                                                          | Yes                                                                                 | Yes, by several firms since 2018, and SOC 2 Type 2                                                                 |

## Choose vauly if

- You want your vault on an account you own, and no server to patch.
- You're a few people and would rather not pay per seat.
- Coding agents, scripts or CI jobs need your API keys, and you'd rather they never see them. See [Agents and scripts](agents.md).
- You want to read all of the code, and change it.

## Choose 1Password or Bitwarden if

- You want native apps on phones and computers, or your passkeys on your phone.
- You need SSO, SCIM, or an audited product to pass a compliance review.
- Your team is more than a handful of people.

## And Vaultwarden?

Vaultwarden is a server for Bitwarden's apps, written in Rust by its community and free under AGPL-3.0. It isn't associated with Bitwarden, Inc. With it you keep Bitwarden's apps, mobile ones included, and run the server yourself: a Docker container behind HTTPS, on a machine you keep up to date. vauly needs no machine at all, but has only its web app, the extension and the CLI.

## Moving over

vauly imports from 1Password, Bitwarden and a dozen other password managers and browsers, with one-time codes, notes and folders. [Moving to vauly](import.md) has the steps for each. You can download a backup any time, protected with a password, which vauly and Bitwarden import, or as a CSV most password managers read, so trying it costs little.

## Sources

Checked on October 23, 2026. Prices are in US dollars per month, billed yearly.
- 1Password: [pricing](https://1password.com/business-pricing), [regions](https://support.1password.com/regions/), [Secret Key](https://support.1password.com/secret-key-security/), [`op run`](https://www.1password.dev/cli/secrets-environment-variables/), [passkeys](https://1password.com/product/passkeys), [security assessments](https://support.1password.com/security-assessments/)
- Bitwarden: [pricing](https://bitwarden.com/pricing/business/), [licenses](https://github.com/bitwarden/server/blob/main/LICENSE_FAQ.md), [self-hosting](https://bitwarden.com/help/install-on-premise-linux/), [encryption](https://bitwarden.com/help/kdf-algorithms/), [Secrets Manager](https://bitwarden.com/products/secrets-manager/), [passkeys](https://bitwarden.com/help/storing-passkeys/), [audits](https://bitwarden.com/help/is-bitwarden-audited/)
- Vaultwarden: [repository](https://github.com/dani-garcia/vaultwarden)
