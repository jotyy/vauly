// The demo at demo.vauly.app is one account that every visitor shares. apps/server/src/demo.ts
// turns these procedures away there, with the reason as the message.

/**
 * What the demo won't do: anything that would lock the next visitor out, change what
 * everyone sees the account called, publish something on a public link, or send one
 * visitor's notifications to another's phone.
 */
export const closedInDemo: Record<string, string> = {
	"account.changePassword":
		"The demo keeps its master password, so the next visitor can sign in.",
	"account.beginTwoStep":
		"Two-step login stays off in the demo, so the next visitor can sign in.",
	"account.confirmTwoStep":
		"Two-step login stays off in the demo, so the next visitor can sign in.",
	"account.updateProfile": "The demo account keeps its name.",
	"members.setTwoStepPolicy":
		"Two-step login stays optional in the demo, so the next visitor can sign in.",
	"account.renameWorkspace": "The demo workspace keeps its name.",
	"links.create":
		"Share links are off in the demo, since anyone could open them.",
	"account.deleteAccount":
		"The demo account stays, so the next visitor can sign in.",
	"members.transferOwnership": "The demo workspace keeps its owner.",
	"account.signEveryoneOut":
		"The demo keeps everyone signed in, since every visitor shares its account.",
	// It swaps the account's keys, and the server can't tell they still come from the
	// same master password: a way around changePassword's turn here.
	"account.upgradeKdf":
		"The demo keeps its master password, so the next visitor can sign in.",
	"push.publicKey":
		"Notifications are off in the demo, since every visitor signs in as the same person.",
	"push.subscribe":
		"Notifications are off in the demo, since every visitor signs in as the same person.",
};
