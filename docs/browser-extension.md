# Browser extension

The extension shows the items for the site you're on, fills the login form with one click, fills checkout and address forms with your cards and identities, copies usernames and passwords, offers to save the logins you type, and keeps your passkeys. It decrypts on your computer, like the web app, and works in Chrome, Edge, Brave, Arc and other Chromium browsers, and in Firefox 153 or later on a computer.

## Install

The extension isn't in a store yet, so you build it from this repository and load it.

### Chrome and other Chromium browsers

```sh
bun install
bun run --cwd apps/extension build
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and pick `apps/extension/.output/chrome-mv3`.
3. Pin vauly to the toolbar.

### Firefox

```sh
bun install
bun run --cwd apps/extension build:firefox
```

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on…** and pick `apps/extension/.output/firefox-mv3/manifest.json`.
3. Pin vauly to the toolbar from the extensions button.

Firefox removes a temporary add-on when it quits; load it again the next time.

In Firefox, vauly's window offering to save a login takes the focus when it opens, since Firefox doesn't open windows in the background. Firefox for Android isn't supported yet: it can't open vauly's own windows, which saving logins and passkeys use.

## Connect and sign in

Open the extension and enter the address you open vauly at, such as `vauly.example.com`. The extension finds your server from there. Then sign in with your email and master password.

## Use it

- **On a login page**, click into the email or password field and vauly's mark shows up inside it, whether or not vauly has a login for the site. Choose it to open the menu with the logins saved for that site, then choose one to fill the form. The menu waits for the mark, so it never fights with the browser's own suggestions under the field. If the login has a one-time code, filling also copies the current code, ready to paste on the next step. Typing, Escape or a click elsewhere closes the menu. When the extension is locked or not signed in yet, the menu offers to do that first.
- **In the extension**, the items saved for the site you're on come first, with a **Fill** button. A login with more than one website shows up, and fills, on each of them.
- **At a checkout or an address form**, open the extension: your cards and identities are under **Cards and identities**, on any site. **Fill** puts a card's holder, number, expiry and security code, or an identity's name, email, phone and address, into the form's fields. vauly finds the fields by the names browsers' own autofill uses (`cc-number`, `postal-code` and so on), or else by their names, and fills nothing on a page without them. A card's PIN is never filled. For now cards and identities fill from the extension, not from the mark inside a field.
- **After you sign in somewhere new**, vauly opens a small window of its own beside the page, without taking the focus, asking whether to save the login and to which vault; the vauly icon shows a badge too, and the extension offers the same. Choose **Not now**, or close the window, to let it go. If you signed in to a saved login with a different password, it offers to update the password instead, and the old one stays under Earlier passwords. Logins you already saved, and anything typed into vauly itself, are never offered.
- **When a site offers to create a passkey**, vauly opens a small window of its own asking whether to save it, and to which vault. If a login for that account is saved already, the passkey goes into it. When the site asks for a passkey to sign in, the window lists the ones vauly has for that site; choose the account. It opens for every passkey request, even where vauly has none, so a site can't find out what you keep. **Use another way** hands the request to the browser instead, for a passkey on your phone, a security key or the device, and closing the window turns the request down. If you haven't entered your master password in the last few minutes, the window asks for it first, as a device asks for your fingerprint; while vauly is locked, it unlocks it. Anyone who can open a vault can sign in with a passkey in it; saving one needs a vault you can edit. The web app shows a passkey on its item, but making and using one happen in the extension. **Don't ask on** a site leaves that site to the browser from then on, and **Offer vauly for passkeys** in the extension's settings (the gear) turns passkeys off everywhere; the settings also list the sites you left out.
- **Search** to find any item; the buttons copy its username, password or one-time code.
- **Settings** (the gear) turns off vauly's passkeys, everywhere or site by site, and the website logos, which come from Brandfetch. When your vauly has logos turned off, the extension doesn't show them either. In Firefox, logos are off until you turn them on here, and Firefox asks you first to let the extension share the websites' domains.
- **Lock** forgets the key. The extension also locks itself after 15 idle minutes, and whenever the browser closes.

Fills, copies and passkey sign-ins appear in **Activity**, like everything else.

Passkeys from other password managers can't be imported yet, and backups leave them out; make new ones at each site with the extension. Passkey sign-in from the suggestions under a username field, and inside a frame embedded in another site, go to the browser for now.

## What it can access

The extension asks to read and change data on all sites. It needs that to fill forms on whatever site you're on, to notice a login being submitted so it can offer to save it, and to reach your vauly server, whose address is different for every team. On each page, a small script watches for a sign-in form being sent and passes the username and password to the extension. The menu it adds to a page is a frame of the extension's own page, so the site can't read the logins listed in it, and it never holds a password: filling happens in the extension itself. The page can't reach into the mark or the menu, and they look the same whatever vauly holds, so a site learns nothing about your vaults from them; the offer to save a login is a window of vauly's own, outside the page. The script changes the page's fields only when you choose a login to fill.

For passkeys, another small script starts with every secure page and passes the site's passkey requests to the extension, which asks you in a window of its own and hands back the answer; the script holds no keys. The extension takes the site's address from the browser, not from the page, so a site can only get the passkeys made for it. A passkey's private key is sealed with its vault's key, so an agent you give the login to can use its password but not its passkey.

What it stores:

| Where                                                          | What                                                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Extension storage (on disk)                                    | Your vauly address, your email and the session token, and whether vauly offers passkeys, with the sites where it doesn't |
| Session storage (memory only, cleared when the browser closes) | Your unlocked private key, when you last used it and when you last entered your master password                          |
| Session storage, per tab, for 5 minutes                        | A login you just typed, until you save or dismiss it                                                                     |
| Session storage, for up to 10 minutes                          | A site's passkey request while vauly's window is open; never a key                                                       |

Your master password is never stored. Pages and other extensions can't read the extension's storage.
