// Brand logos for items, from Brandfetch's logo CDN, shared by the web app and the
// browser extension. Only a brand's own domain is ever looked up: never a subdomain,
// a private network name or anything else from the item.

/** The vauly project's Brandfetch client ID; an instance can use its own. */
export const BRANDFETCH_CLIENT_ID = "1idzU4xXvIcwxy_dNwT";

/** Where the logos load from, which the web app's Content-Security-Policy allows. */
export const LOGO_ORIGIN = "https://cdn.brandfetch.io";

type Kind = string;

/**
 * Well-known services, found by name for items without a website (API keys, mostly). The
 * first match wins, so a more specific name goes before a general one: "Google Cloud"
 * before "Google", "Alibaba Cloud" before "Amazon". Only the brand's own domain is ever
 * looked up.
 */
const brands: [RegExp, string][] = [
	// Code, CI and package registries
	[/\bgithub\b/, "github.com"],
	[/\bgitlab\b/, "gitlab.com"],
	[/\bbitbucket\b/, "bitbucket.org"],
	[/\bgitea\b/, "gitea.com"],
	[/\bcodeberg\b/, "codeberg.org"],
	[/\bsourcehut\b/, "sr.ht"],
	[/\bcircleci\b/, "circleci.com"],
	[/\btravis\b/, "travis-ci.com"],
	[/\bjenkins\b/, "jenkins.io"],
	[/\bbuildkite\b/, "buildkite.com"],
	[/\bcodecov\b/, "codecov.io"],
	[/\bsonar(cloud|qube)\b/, "sonarsource.com"],
	[/\bsnyk\b/, "snyk.io"],
	[/\bdependabot\b/, "github.com"],
	[/\bnpm\b/, "npmjs.com"],
	[/\bpypi\b/, "pypi.org"],
	[/\brubygems\b/, "rubygems.org"],
	[/\bcrates\.io\b/, "crates.io"],
	[/\bpackagist\b/, "packagist.org"],
	[/\bnuget\b/, "nuget.org"],
	[/\bmaven\b/, "maven.apache.org"],
	[/\bdocker\b/, "docker.com"],
	[/\bquay\b/, "quay.io"],
	[/\bjfrog\b|\bartifactory\b/, "jfrog.com"],
	[/\bpostman\b/, "postman.com"],
	[/\binsomnia\b/, "insomnia.rest"],
	[/\bswagger\b/, "swagger.io"],
	[/\bcursor\b/, "cursor.com"],
	[/\bjetbrains\b|\bintellij\b|\bwebstorm\b|\bpycharm\b/, "jetbrains.com"],
	[/\bvs ?code\b|\bvisual studio\b/, "visualstudio.com"],
	[/\bexpo\b/, "expo.dev"],
	[/\bstorybook\b|\bchromatic\b/, "chromatic.com"],
	[/\bbrowserstack\b/, "browserstack.com"],
	[/\bsauce labs\b/, "saucelabs.com"],
	[/\blambdatest\b/, "lambdatest.com"],
	[/\bpercy\b/, "percy.io"],
	// AI
	[/\bopenai\b|\bchatgpt\b/, "openai.com"],
	[/\banthropic\b|\bclaude\b/, "anthropic.com"],
	[/\bgemini\b/, "gemini.google.com"],
	[/\bmistral\b/, "mistral.ai"],
	[/\bcohere\b/, "cohere.com"],
	[/\bhugging ?face\b/, "huggingface.co"],
	[/\breplicate\b/, "replicate.com"],
	[/\bgroq\b/, "groq.com"],
	[/\btogether\.ai\b|\btogether ai\b/, "together.ai"],
	[/\bperplexity\b/, "perplexity.ai"],
	[/\bdeepseek\b/, "deepseek.com"],
	[/\bxai\b|\bgrok\b/, "x.ai"],
	[/\belevenlabs\b/, "elevenlabs.io"],
	[/\bstability\b/, "stability.ai"],
	[/\bmidjourney\b/, "midjourney.com"],
	[/\bopenrouter\b/, "openrouter.ai"],
	[/\bpinecone\b/, "pinecone.io"],
	[/\bweaviate\b/, "weaviate.io"],
	[/\bqdrant\b/, "qdrant.tech"],
	[/\blangchain\b|\blangsmith\b/, "langchain.com"],
	[/\bwandb\b|\bweights ?& ?biases\b/, "wandb.ai"],
	// Cloud and hosting
	[/\baws\b|\bamazon web services\b/, "aws.amazon.com"],
	[/\bgoogle cloud\b|\bgcp\b/, "cloud.google.com"],
	[/\bazure\b/, "azure.microsoft.com"],
	[/\bcloudflare\b/, "cloudflare.com"],
	[/\bvercel\b/, "vercel.com"],
	[/\bnetlify\b/, "netlify.com"],
	[/\bheroku\b/, "heroku.com"],
	[/\bdigitalocean\b/, "digitalocean.com"],
	[/\bhetzner\b/, "hetzner.com"],
	[/\bfly\.io\b/, "fly.io"],
	[/\brailway\b/, "railway.com"],
	[/\brender\b/, "render.com"],
	[/\blinode\b|\bakamai\b/, "akamai.com"],
	[/\bvultr\b/, "vultr.com"],
	[/\bscaleway\b/, "scaleway.com"],
	[/\bovh\b/, "ovhcloud.com"],
	[/\boracle cloud\b|\boci\b/, "oracle.com"],
	[/\bibm cloud\b/, "ibm.com"],
	[/\balibaba cloud\b|\baliyun\b/, "alibabacloud.com"],
	[/\btencent cloud\b/, "tencentcloud.com"],
	[/\bhuawei cloud\b/, "huaweicloud.com"],
	[/\bdeno\b/, "deno.com"],
	[/\bbun\.sh\b/, "bun.sh"],
	[/\bcloudinary\b/, "cloudinary.com"],
	[/\bimgix\b/, "imgix.com"],
	[/\bbackblaze\b/, "backblaze.com"],
	[/\bwasabi\b/, "wasabi.com"],
	[/\bbunny(\.net| cdn)\b/, "bunny.net"],
	[/\bfastly\b/, "fastly.com"],
	[/\btailscale\b/, "tailscale.com"],
	[/\bngrok\b/, "ngrok.com"],
	[/\bnamecheap\b/, "namecheap.com"],
	[/\bgodaddy\b/, "godaddy.com"],
	[/\bporkbun\b/, "porkbun.com"],
	[/\bhostinger\b/, "hostinger.com"],
	[/\bgandi\b/, "gandi.net"],
	[/\bhover\b/, "hover.com"],
	// Data
	[/\bsupabase\b/, "supabase.com"],
	[/\bfirebase\b/, "firebase.google.com"],
	[/\bmongodb\b|\bmongo\b/, "mongodb.com"],
	[/\bpostgres(ql)?\b/, "postgresql.org"],
	[/\bmysql\b/, "mysql.com"],
	[/\bmariadb\b/, "mariadb.org"],
	[/\bredis\b/, "redis.io"],
	[/\bneon\b(?! light)/, "neon.tech"],
	[/\bplanetscale\b/, "planetscale.com"],
	[/\bturso\b/, "turso.tech"],
	[/\bupstash\b/, "upstash.com"],
	[/\bconvex\b/, "convex.dev"],
	[/\bprisma\b/, "prisma.io"],
	[/\bclickhouse\b/, "clickhouse.com"],
	[/\bsnowflake\b/, "snowflake.com"],
	[/\bdatabricks\b/, "databricks.com"],
	[/\bbigquery\b/, "cloud.google.com"],
	[/\belastic(search)?\b/, "elastic.co"],
	[/\bairtable\b/, "airtable.com"],
	// Auth and identity
	[/\bauth0\b/, "auth0.com"],
	[/\bokta\b/, "okta.com"],
	[/\bclerk\b/, "clerk.com"],
	[/\bkinde\b/, "kinde.com"],
	[/\bworkos\b/, "workos.com"],
	[/\b1password\b/, "1password.com"],
	[/\bbitwarden\b/, "bitwarden.com"],
	[/\bproton\b/, "proton.me"],
	[/\byubi(co|key)\b/, "yubico.com"],
	// Monitoring and ops
	[/\bsentry\b/, "sentry.io"],
	[/\bdatadog\b/, "datadoghq.com"],
	[/\bgrafana\b/, "grafana.com"],
	[/\bnew relic\b/, "newrelic.com"],
	[/\bhoneycomb\b/, "honeycomb.io"],
	[/\baxiom\b/, "axiom.co"],
	[/\bbetter ?stack\b|\blogtail\b/, "betterstack.com"],
	[/\bpagerduty\b/, "pagerduty.com"],
	[/\bopsgenie\b/, "atlassian.com"],
	[/\bpingdom\b/, "pingdom.com"],
	[/\buptime ?robot\b/, "uptimerobot.com"],
	[/\bcheckly\b/, "checklyhq.com"],
	[/\bcronitor\b/, "cronitor.io"],
	[/\bposthog\b/, "posthog.com"],
	[/\bmixpanel\b/, "mixpanel.com"],
	[/\bamplitude\b/, "amplitude.com"],
	[/\bsegment\b/, "segment.com"],
	[/\bgoogle analytics\b/, "analytics.google.com"],
	[/\bplausible\b/, "plausible.io"],
	[/\bfathom\b/, "usefathom.com"],
	[/\bhotjar\b/, "hotjar.com"],
	[/\blaunchdarkly\b/, "launchdarkly.com"],
	// Messaging and email
	[/\btwilio\b/, "twilio.com"],
	[/\bsendgrid\b/, "sendgrid.com"],
	[/\bmailgun\b/, "mailgun.com"],
	[/\bresend\b/, "resend.com"],
	[/\bpostmark\b/, "postmarkapp.com"],
	[/\bmailjet\b/, "mailjet.com"],
	[/\bbrevo\b|\bsendinblue\b/, "brevo.com"],
	[/\bmailchimp\b/, "mailchimp.com"],
	[/\bcustomer\.io\b/, "customer.io"],
	[/\bklaviyo\b/, "klaviyo.com"],
	[/\bloops\b/, "loops.so"],
	[/\bbeehiiv\b/, "beehiiv.com"],
	[/\bconvertkit\b|\bkit\.com\b/, "kit.com"],
	[/\bfastmail\b/, "fastmail.com"],
	[/\bhey\.com\b/, "hey.com"],
	[/\bslack\b/, "slack.com"],
	[/\bdiscord\b/, "discord.com"],
	[/\btelegram\b/, "telegram.org"],
	[/\bwhatsapp\b/, "whatsapp.com"],
	[/\bsignal\b(?! box)/, "signal.org"],
	[/\bzoom\b/, "zoom.us"],
	[/\bintercom\b/, "intercom.com"],
	[/\bzendesk\b/, "zendesk.com"],
	[/\bfreshdesk\b|\bfreshworks\b/, "freshworks.com"],
	[/\bhelp ?scout\b/, "helpscout.com"],
	[/\bcrisp\b/, "crisp.chat"],
	[/\bfront\.com\b|\bfront app\b/, "front.com"],
	[/\bcalendly\b/, "calendly.com"],
	[/\bcal\.com\b/, "cal.com"],
	[/\bloom\b/, "loom.com"],
	// Work and design
	[/\bnotion\b/, "notion.so"],
	[/\blinear\b/, "linear.app"],
	[/\bjira\b|\batlassian\b|\bconfluence\b|\btrello\b/, "atlassian.com"],
	[/\basana\b/, "asana.com"],
	[/\bmonday\.com\b/, "monday.com"],
	[/\bclickup\b/, "clickup.com"],
	[/\bbasecamp\b/, "basecamp.com"],
	[/\bcoda\b/, "coda.io"],
	[/\bmiro\b/, "miro.com"],
	[/\bfigma\b/, "figma.com"],
	[/\bsketch\b/, "sketch.com"],
	[/\bframer\b/, "framer.com"],
	[/\bwebflow\b/, "webflow.com"],
	[/\bcanva\b/, "canva.com"],
	[/\badobe\b|\bphotoshop\b|\bcreative cloud\b/, "adobe.com"],
	[/\bwordpress\b/, "wordpress.com"],
	[/\bsquarespace\b/, "squarespace.com"],
	[/\bwix\b/, "wix.com"],
	[/\bghost\b/, "ghost.org"],
	[/\bsubstack\b/, "substack.com"],
	[/\bmedium\b/, "medium.com"],
	[/\bzapier\b/, "zapier.com"],
	[/\bmake\.com\b/, "make.com"],
	[/\bn8n\b/, "n8n.io"],
	[/\bdropbox\b/, "dropbox.com"],
	[/\bbox\.com\b/, "box.com"],
	[/\bgoogle drive\b|\bgoogle workspace\b|\bgoogle\b|\bgmail\b/, "google.com"],
	[
		/\bmicrosoft\b|\boffice 365\b|\bmicrosoft 365\b|\boutlook\b|\bteams\b/,
		"microsoft.com",
	],
	[/\bapple\b|\bicloud\b|\bapp store connect\b/, "apple.com"],
	[/\bzoho\b/, "zoho.com"],
	[/\bhubspot\b/, "hubspot.com"],
	[/\bsalesforce\b/, "salesforce.com"],
	[/\bpipedrive\b/, "pipedrive.com"],
	[/\bdocusign\b/, "docusign.com"],
	[/\btypeform\b/, "typeform.com"],
	[/\btally\b/, "tally.so"],
	// Money
	[/\bstripe\b/, "stripe.com"],
	[/\bpaddle\b/, "paddle.com"],
	[/\blemon ?squeezy\b/, "lemonsqueezy.com"],
	[/\bgumroad\b/, "gumroad.com"],
	[/\bpaypal\b/, "paypal.com"],
	[/\bbraintree\b/, "braintreepayments.com"],
	[/\bsquareup\b|\bsquare (pos|pay|dashboard)\b/, "squareup.com"],
	[/\badyen\b/, "adyen.com"],
	[/\bwise\b/, "wise.com"],
	[/\brevolut\b/, "revolut.com"],
	[/\bmercury\b/, "mercury.com"],
	[/\bbrex\b/, "brex.com"],
	[/\bramp\.com\b|\bramp card\b/, "ramp.com"],
	[/\bquickbooks\b|\bintuit\b/, "intuit.com"],
	[/\bxero\b/, "xero.com"],
	[/\bgusto\b/, "gusto.com"],
	[/\bdeel\b/, "deel.com"],
	[/\brippling\b/, "rippling.com"],
	[/\bcoinbase\b/, "coinbase.com"],
	[/\bbinance\b/, "binance.com"],
	[/\bkraken\b/, "kraken.com"],
	[/\bmetamask\b/, "metamask.io"],
	[/\bledger\b/, "ledger.com"],
	[/\bshopify\b/, "shopify.com"],
	[/\bwoocommerce\b/, "woocommerce.com"],
	[/\bamazon\b/, "amazon.com"],
	[/\betsy\b/, "etsy.com"],
	[/\bebay\b/, "ebay.com"],
	// Social and media
	[/\bfacebook\b|\bmeta\b/, "facebook.com"],
	[/\binstagram\b/, "instagram.com"],
	[/\bthreads\b/, "threads.net"],
	[/\blinkedin\b/, "linkedin.com"],
	[/\btwitter\b|\bx\.com\b/, "x.com"],
	[/\bbluesky\b/, "bsky.app"],
	[/\bmastodon\b/, "joinmastodon.org"],
	[/\breddit\b/, "reddit.com"],
	[/\byoutube\b/, "youtube.com"],
	[/\btiktok\b/, "tiktok.com"],
	[/\bpinterest\b/, "pinterest.com"],
	[/\bsnapchat\b/, "snapchat.com"],
	[/\btwitch\b/, "twitch.tv"],
	[/\bspotify\b/, "spotify.com"],
	[/\bnetflix\b/, "netflix.com"],
	[/\bsteam\b/, "steampowered.com"],
	[/\bepic games\b/, "epicgames.com"],
	[/\bnintendo\b/, "nintendo.com"],
	[/\bplaystation\b/, "playstation.com"],
	[/\bxbox\b/, "xbox.com"],
	[/\bpatreon\b/, "patreon.com"],
	[/\bbuffer\b/, "buffer.com"],
	[/\btypefully\b/, "typefully.com"],
	[/\bvimeo\b/, "vimeo.com"],
	[/\bmux\b/, "mux.com"],
	// Everyday
	[/\buber\b/, "uber.com"],
	[/\blyft\b/, "lyft.com"],
	[/\bairbnb\b/, "airbnb.com"],
	[/\bbooking\.com\b/, "booking.com"],
	[/\bexpedia\b/, "expedia.com"],
	[/\bdoordash\b/, "doordash.com"],
	[/\bwalmart\b/, "walmart.com"],
	[/\btarget\.com\b/, "target.com"],
	[/\bikea\b/, "ikea.com"],
	[/\bchase\b/, "chase.com"],
	[/\bbank of america\b/, "bankofamerica.com"],
	[/\bwells fargo\b/, "wellsfargo.com"],
	[/\bcapital one\b/, "capitalone.com"],
	[/\bamerican express\b|\bamex\b/, "americanexpress.com"],
	[/\bhsbc\b/, "hsbc.com"],
	[/\bbarclays\b/, "barclays.co.uk"],
	[/\bmonzo\b/, "monzo.com"],
	[/\bn26\b/, "n26.com"],
	[/\bschwab\b/, "schwab.com"],
	[/\bfidelity\b/, "fidelity.com"],
	[/\bvanguard\b/, "vanguard.com"],
	[/\brobinhood\b/, "robinhood.com"],
	[/\bvenmo\b/, "venmo.com"],
	[/\bcash app\b/, "cash.app"],
	[/\balipay\b/, "alipay.com"],
	[/\bwechat\b|\bweixin\b/, "wechat.com"],
	[/\btaobao\b/, "taobao.com"],
	[/\bjd\.com\b/, "jd.com"],
	[/\bbaidu\b/, "baidu.com"],
	[/\bfeishu\b|\blark\b/, "larksuite.com"],
	[/\bdingtalk\b/, "dingtalk.com"],
	[/\bbilibili\b/, "bilibili.com"],
	[/\bxiaohongshu\b|\brednote\b/, "xiaohongshu.com"],
	[/\bline\.me\b|\bline app\b/, "line.me"],
	[/\bkakao\b/, "kakaocorp.com"],
	[/\bnaver\b/, "naver.com"],
	[/\brakuten\b/, "rakuten.com"],
	[/\bmercari\b/, "mercari.com"],
];

function hostOf(url: string) {
	try {
		const { hostname } = new URL(
			/^\w+:\/\//.test(url) ? url : `https://${url}`,
		);
		return hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

// Names that only mean something on a private network: never sent anywhere.
const PRIVATE_SUFFIX =
	/\.(local|localhost|internal|intranet|lan|home|corp|test|example|invalid)$/;

/**
 * The part of a host a brand owns: "app.hubspot.com" → "hubspot.com", and
 * "shop.example.co.uk" → "example.co.uk". Subdomains, which can name internal systems,
 * stay on the device.
 */
export function brandDomain(host: string) {
	const labels = host.toLowerCase().split(".").filter(Boolean);
	if (labels.length < 2) return null;
	if (/^\d+$/.test(labels.at(-1) ?? "")) return null;
	const joined = labels.join(".");
	if (PRIVATE_SUFFIX.test(`.${joined}`)) return null;
	const take = /^(co|com|net|org|gov|edu|ac|ne|or)\.[a-z]{2}$/.test(
		labels.slice(-2).join("."),
	)
		? 3
		: 2;
	return labels.slice(-take).join(".");
}

/** The domain whose logo stands for an item, or null to keep the plain icon. */
export function logoDomain(item: { kind: Kind; name: string; url?: string }) {
	// Cards and identities are named by people, not services (see the web app's logos.ts).
	if (item.kind === "card" || item.kind === "identity") return null;
	if (item.url) {
		const domain = brandDomain(hostOf(item.url));
		if (domain) return domain;
	}
	// A note named "Apple pie" is no Apple account.
	if (item.kind === "note") return null;
	const name = item.name.toLowerCase();
	return brands.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

/** A square icon, twice the shown size for sharp screens; a 404 when there's none. */
export function logoUrl(
	domain: string,
	size: number,
	clientId = BRANDFETCH_CLIENT_ID,
) {
	const px = size * 2;
	return `${LOGO_ORIGIN}/${encodeURIComponent(domain)}/w/${px}/h/${px}/fallback/404/icon?c=${clientId}`;
}
