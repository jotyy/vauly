# Moving to vauly

vauly imports from 1Password, Bitwarden, LastPass, Dashlane, Keeper, NordPass, RoboForm, Proton Pass, KeePass, KeePassXC, Enpass, Apple Passwords, Chrome, Edge, Brave and Firefox, and from any CSV file with a password column. Your logins come over with their one-time codes, notes and folders. The export is read and encrypted in your browser, so its contents never reach the server in plain text.

## How it works

1. In vauly, go to **All items** and choose **Import**. A new workspace also offers **Import from…** in Get started.
2. Pick the app you're moving from. Each one says which file it exports, and vauly then shows how to export it.
3. Export from that app, then drop the file into vauly. vauly works out the format from what's inside the file, so it doesn't matter what the file is called.
4. Check what comes over, and choose the vault it goes to. Items already in that vault are left out, so importing the same file twice does no harm.
5. Choose **Import**, then delete the export file and empty your trash. It holds your passwords in plain text.

Each app exports in its own way, so use the richest format it offers. The sections below say which one that is.

## What comes over

| In the other app                                           | In vauly                              |
| ---------------------------------------------------------- | ------------------------------------- |
| Logins: username, password, website, one-time code (TOTP)  | Logins                                |
| Secure notes                                               | Notes                                 |
| API credentials, and custom items that hold a key or token | API keys                              |
| SSH keys                                                   | SSH keys                              |
| Wi-Fi, servers, databases and email accounts               | Logins, with the details in the notes |
| Folders, vaults, collections and groups                    | Tags, such as `Work/Clients`          |
| Tags                                                       | Tags                                  |
| Archived items                                             | Items tagged `Archived`               |
| More websites, custom fields, security questions           | Lines in the notes                    |
| Earlier passwords (1Password, Bitwarden, KeePass)          | Earlier passwords                     |
| Payment cards                                              | Cards                                 |
| Identities and addresses                                   | Identities                            |
| Passport, licence and ID numbers on an identity            | Hidden fields on the identity         |

Cards and identities come over from 1Password's 1PUX, Bitwarden's JSON, Proton Pass, Enpass, Keeper's JSON and Dashlane's ZIP. CSV exports leave out their details, so the review says to use one of those instead. vauly doesn't store bank accounts, or passports and other documents as items of their own, so those stay behind. Files come over from 1Password's 1PUX (Documents and the files attached to items), Bitwarden's ZIP with attachments, and KeePass and KeePassXC (databases and XML exports alike), up to your vauly's limit on files; the review names any that are too big. One import unpacks at most 256 MB from a ZIP, and files past that stay behind too. Other apps' attachments stay behind, and so do passkeys (vauly's browser extension makes new ones), Proton Pass email aliases and items in the trash. Before you import, the review lists everything that stays behind.

Favorites, sharing and permissions don't come over either. Share vaults with your team in vauly once your items are in.

## 1Password

Use the 1PUX format. It keeps one-time codes, API credentials, SSH keys, tags, files and every vault. A Document comes over as a note with its file. 1Password's CSV holds only logins and passwords.
1. Open the 1Password app on a Mac, Windows or Linux computer. You can't export from 1Password.com or a phone.
2. On a Mac, choose **File › Export** and pick your account. On Windows or Linux, select **⋯** at the top of the sidebar, then **Export**, and pick your account.
3. Enter your account password.
4. Choose **1PUX** as the format, select **Export Data**, and save the file.

Each item is tagged with the name of the vault it came from when the export has more than one vault. Business accounts can turn exporting off for their members; ask an administrator if you don't see **Export**. [1Password's help](https://support.1password.com/export/)

## Bitwarden

Use **.json (Encrypted)** with a file password. It keeps folders, custom fields, SSH keys and earlier passwords, and the file is never in plain text on your computer.
1. In the Bitwarden web app, go to **Tools › Export vault**. The browser extension has the same under **Settings › Vault options › Export vault**.
2. Under **Export from**, choose **My vault**. Export each organization separately to bring its collections along.
3. Choose **.json (Encrypted)** as the file format, then **Password protected**, and set a file password.
4. Select **Export** and confirm with your master password.
5. When you bring the file to vauly, enter the file password. vauly opens the file in your browser and doesn't keep the password.

An **Account restricted** export is sealed with your Bitwarden account's own key, so only Bitwarden can open it. The plain **.json** works too, and so does **.zip (with attachments)**, which brings the attachments. Bitwarden names each item's folder of files after the item, so when two items share a name, their files stay behind; the review counts them. Delete a plain export once it's imported. [Bitwarden's help](https://bitwarden.com/help/export-your-data/)

## LastPass

LastPass only exports a CSV file, from its browser extension.
1. Select the LastPass button in your browser's toolbar and log in.
2. Go to **Account › Fix a problem yourself › Export vault items**.
3. Choose **Export data for use anywhere**, then **Continue**.
4. Enter your master password. LastPass saves a CSV file.

In Safari the CSV opens in a tab instead. Save the page with **File › Save As**, and import that file. LastPass leaves attachments and custom fields out of the export, and often the one-time codes too. Secure notes of the SSH key, server, database and Wi-Fi kinds come over as SSH keys and logins. [LastPass's help](https://community.lastpass.com/kb/articles/40-export-vault-data-from-lastpass-as-a-generic-csv-file)

## Dashlane

1. Open the Dashlane web app and choose **Settings** from the **Vault** menu at the top left.
2. Choose **Export data**, then **Export to CSV**.
3. Unlock with your master password. Dashlane saves a ZIP file.

Import the ZIP as it is. The iPhone and Android apps save a folder of CSV files instead. From those, import `credentials.csv` for your logins and `securenotes.csv` for your notes. [Dashlane's help](https://support.dashlane.com/hc/en-us/articles/32905278138002-Export-your-Dashlane-data-to-a-CSV)

## Keeper

Use JSON. It keeps one-time codes, SSH keys, shared folders and each record's type.
1. In the Keeper web vault or desktop app, open the account menu at the top right and choose **Settings**.
2. Choose **Export**.
3. Choose **JSON**, then **Export**.
4. Enter your master password and choose **Export Now**.

Keeper's CSV works too. Your role must allow exporting. [Keeper's docs](https://docs.keeper.io/en/user-guides/export-and-reports/vault-export)

## NordPass

1. Open the NordPass desktop app or web vault. You can't export from a phone.
2. Select the gear at the top left to open **Settings**.
3. Under **Import and Export**, select **Export**.
4. Enter your master password and save the CSV file.

[NordPass's help](https://support.nordpass.com/hc/en-us/articles/360007646477-How-to-export-passwords-from-NordPass)

## RoboForm

1. Select the RoboForm button in your browser's toolbar, then **⋯ › Settings**.
2. Choose **Account & Data**, then **Export**.
3. Enter your master password and select **Export**. RoboForm saves a CSV file.

The CSV holds logins and safenotes, with their one-time codes. Identities and contacts stay behind, and so do bookmarks. [RoboForm's help](https://help.roboform.com/hc/en-us/articles/230425008-How-to-export-your-RoboForm-logins-into-a-CSV-file)

## Proton Pass

Use the PGP-encrypted export.
1. Open Proton Pass on the web, in the browser extension or in the desktop app. You can't export from a phone.
2. Open **Settings** and choose **Export**.
3. Choose **PGP-encrypted** and set a passphrase.
4. Select **Export** and save the file.
5. When you bring the file to vauly, enter the passphrase. vauly opens the file in your browser and doesn't keep the passphrase.

The plain **ZIP** works too, and so does a `.pgp` file from an older export. Delete a plain export once it's imported.

The export holds only the vaults you own. Each item is tagged with its vault and folder. [Proton's help](https://proton.me/support/pass-export)

## KeePass

Bring the `.kdbx` database itself; there's nothing to export. It keeps groups, tags, custom fields, one-time codes, earlier passwords and attachments, which come as files.
1. Close the database in KeePass, so everything is saved.
2. Drop its `.kdbx` file into vauly.
3. Enter its password, and choose its key file if it has one.

vauly opens the database in your browser, in a worker that can't connect anywhere, and the password never leaves it. It reads KDBX 3.1 and 4, with AES-KDF or Argon2, but not KDBX 2.x, from KeePass before 2.20: open such a database in a current KeePass or KeePassXC and save it first. A database whose key settings ask for more than 1 GiB of memory, 100 Argon2 passes, 16 lanes or 200 million AES-KDF rounds is turned away, with the setting to lower under **Database Settings › Security**.

A database that needs your Windows user account can't be opened outside KeePass. For that one, choose **File › Export › KeePass XML (2.x)** and bring that file instead; it keeps the same things. Entries in the Recycle Bin stay behind either way, and so do attachments on an entry's earlier versions. **KeePass CSV (1.x)** works too, but it has only titles, usernames, passwords, websites and notes. [KeePass's help](https://keepass.info/help/base/importexport.html)

## KeePassXC

Bring the `.kdbx` database itself, as for [KeePass](#keepass): close it in KeePassXC, drop the file into vauly, and enter its password and key file. It keeps groups, tags, custom fields, one-time codes, earlier passwords and attachments.

A database that needs a YubiKey (challenge-response) can't be opened outside KeePassXC. For that one, choose **Database › Export › XML File…** and bring that file instead. KeePassXC's CSV works too, with one-time codes but without tags and custom fields. [KeePassXC's user guide](https://keepassxc.org/docs/KeePassXC_UserGuide)

## Enpass

1. Open Enpass on your computer.
2. Choose **File › Export**. On Windows, the **File** menu is behind **☰**.
3. Choose the vault and **.json** as the format.
4. Choose where to save it, then **Export**.

Enpass's tags and folders become tags in vauly. Items with a password come over as logins, notes as notes. [Enpass's help](https://help.enpass.io/personal/latest/all/importing-from-enpass)

## Apple Passwords

On a Mac with macOS Sequoia or later:
1. Open the **Passwords** app.
2. Choose **File › Export All Passwords to File**, then **Export Passwords**.
3. Save the CSV file.

On an iPhone or iPad, go to **Settings › Apps › Safari**, tap **Export** under **History and Website Data**, choose only **Passwords** and save to Downloads. In Safari 18 on a Mac, choose **File › Export Browsing Data to File** and select **Passwords**. Both save a ZIP file, which vauly reads as it is.

On older Macs, use Safari: **File › Export › Passwords**. Wi-Fi passwords, passkeys and passwords shared with you in a group aren't exported. [Apple's help](https://support.apple.com/guide/passwords/mchl35b12625/mac)

## Chrome

1. In Chrome, go to `chrome://password-manager/settings`.
2. Next to **Export passwords**, select **Download file**.
3. Confirm with your computer's password if asked, and save the CSV file.

[Google's help](https://support.google.com/chrome/answer/95606)

## Edge

1. In Edge, select **⋯ › Passwords**.
2. Select **⋯**, then **Export passwords**.
3. Select **Export**, confirm with your computer's password, and save the CSV file.

You can't export passwords from Edge on a phone. [Microsoft's help](https://support.microsoft.com/en-us/edge/export-passwords-in-microsoft-edge)

## Brave

1. In Brave, go to `brave://password-manager/settings`.
2. Next to **Export passwords**, select **Download file**.
3. Confirm with your computer's password if asked, and save the CSV file.

## Firefox

1. In Firefox, open the **≡** menu and choose **Passwords**.
2. Select **⋯** at the top right, then **Export Passwords…**
3. Select **Continue with export**, confirm with your computer's password or your Primary Password, and save the file.

Firefox's CSV has no notes or one-time codes. [Mozilla's help](https://support.mozilla.org/kb/export-login-data-firefox)

## Another app

Most password managers can export a CSV file. vauly imports one whose first row names the columns, as long as one of them is called `password` or `notes`. It also reads these columns:

| Field         | Column names                                                     |
| ------------- | ---------------------------------------------------------------- |
| Name          | `name`, `title`, `item`, `account`                               |
| Username      | `username`, `user`, `login`, `email`                             |
| Website       | `url`, `uri`, `website`, `site`                                  |
| One-time code | `totp`, `otpauth`, `otp` (an `otpauth://` link or the setup key) |
| Notes         | `notes`, `note`, `comments`, `extra`                             |
| Folder        | `folder`, `group`, `category`                                    |
| Tags          | `tags`, separated by commas or semicolons                        |

A vauly backup (**Settings › Backup › Download a backup**) imports too, and keeps each item's kind and tags. For a backup protected with a password, vauly asks for the password you chose when you downloaded it. A backup ZIP brings each item's files back too, within your vauly's limits on files. Bitwarden imports a protected backup as **.json (Encrypted)**, without its files.

## Keep it safe

- Export on a computer you trust, and import right away.
- Delete the export file as soon as the import is done, and empty the trash. It holds every password in plain text.
- Check a few items in vauly, then delete or close your account with the old app once you've moved for good.
