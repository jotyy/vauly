import { useEffect, useState } from "react";

import { parseTotp, totpCode } from "@/lib/secrets";

import { CopyButton } from "./copy-button";

export function OneTimeCode({
	secret,
	source,
	onCopied,
}: {
	secret: string;
	source?: string;
	onCopied?: () => void;
}) {
	const config = parseTotp(secret);
	const period = config?.period ?? 30;
	const [now, setNow] = useState(() => Date.now());
	const [code, setCode] = useState<string | null>(null);
	const [broken, setBroken] = useState(false);
	const slot = Math.floor(now / 1000 / period);

	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the code only changes with the slot or the secret
	useEffect(() => {
		if (!config) return;
		let cancelled = false;
		totpCode(config, slot * period * 1000)
			.then((value) => !cancelled && setCode(value))
			.catch(() => !cancelled && setBroken(true));
		return () => {
			cancelled = true;
		};
	}, [slot, secret]);

	if (!config || broken) {
		return (
			<span className="text-caption text-danger">
				This isn't a valid one-time code secret
			</span>
		);
	}

	const left = period - (Math.floor(now / 1000) % period);
	const circumference = 2 * Math.PI * 6;

	return (
		<div className="flex items-center gap-2">
			<span
				data-slot="one-time-code"
				className="text-body-sm text-fg font-mono tracking-wider tabular-nums"
			>
				{code ? `${code.slice(0, 3)} ${code.slice(3)}` : "··· ···"}
			</span>
			<span className="text-caption text-fg-subtle flex items-center gap-1 tabular-nums">
				<svg viewBox="0 0 16 16" className="size-3.5 -rotate-90" aria-hidden>
					<circle
						cx="8"
						cy="8"
						r="6"
						fill="none"
						strokeWidth="2"
						className="stroke-line"
					/>
					<circle
						cx="8"
						cy="8"
						r="6"
						fill="none"
						strokeWidth="2"
						strokeLinecap="round"
						strokeDasharray={circumference}
						strokeDashoffset={circumference * (1 - left / period)}
						className={left <= 5 ? "stroke-danger" : "stroke-brand"}
					/>
				</svg>
				{left}s
			</span>
			{code && (
				<CopyButton
					value={code}
					label="one-time code"
					source={source}
					onCopied={onCopied}
				/>
			)}
		</div>
	);
}
