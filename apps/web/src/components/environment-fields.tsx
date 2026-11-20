import { CheckIcon, CopySimpleIcon } from "@phosphor-icons/react";
import { Button } from "@vauly/ui/components/button";
import { useState } from "react";

import { environmentReferences } from "@/lib/proposals";
import type { CustomField, Item } from "@/lib/vault-data";

import { CopyButton } from "./copy-button";
import { copyToClipboard } from "./notify";
import { SecretValue } from "./secret-value";

/**
 * An environment's variables as a table of names and masked values, and the lines that
 * reference them, to put in a project's .env instead of the values.
 */
export function EnvironmentFields({
	item,
	onUse,
}: {
	item: Item;
	onUse: (action: "revealed" | "copied", field: CustomField) => void;
}) {
	const fields = item.fields ?? [];
	const [copied, setCopied] = useState(false);
	const references = environmentReferences(item);

	const copyReferences = async () => {
		const done = await copyToClipboard(references.join("\n"), {
			label: "references",
			source: item.name,
			secret: false,
		});
		if (!done) return;
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};

	return (
		<section aria-label="Variables" className="flex flex-col gap-2 pt-3 pb-1">
			<div className="flex items-center justify-between gap-2">
				<h3 className="text-body-sm text-fg">
					Variables
					<span className="text-fg-subtle ml-1.5 tabular-nums">
						{fields.length}
					</span>
				</h3>
				<Button
					variant="outline"
					size="xs"
					disabled={fields.length === 0}
					onClick={copyReferences}
				>
					{copied ? (
						<CheckIcon data-icon="inline-start" className="text-success" />
					) : (
						<CopySimpleIcon data-icon="inline-start" />
					)}
					Copy references
				</Button>
			</div>
			{fields.length === 0 ? (
				<p className="text-caption text-fg-subtle py-3">
					No variables yet. Edit it to add some, or let an agent propose them
					with vauly put.
				</p>
			) : (
				<table className="w-full table-fixed border-collapse">
					<thead className="sr-only">
						<tr>
							<th scope="col">Name</th>
							<th scope="col">Value</th>
						</tr>
					</thead>
					<tbody className="divide-line-subtle divide-y">
						{fields.map((field) => (
							<tr key={field.id ?? field.label} data-slot="variable">
								<th
									scope="row"
									className="text-caption text-fg w-2/5 truncate py-2 pr-3 text-left font-mono font-normal"
									title={field.label}
								>
									{field.label}
								</th>
								<td className="py-1.5">
									<div className="flex min-w-0 items-center gap-1">
										{field.hidden ? (
											<SecretValue
												value={field.value}
												label={field.label}
												source={item.name}
												onReveal={() => onUse("revealed", field)}
												onCopied={() => onUse("copied", field)}
											/>
										) : (
											<>
												<span className="text-body-sm text-fg min-w-0 flex-1 truncate font-mono">
													{field.value}
												</span>
												<CopyButton
													value={field.value}
													label={field.label}
													source={item.name}
													secret={false}
													onCopied={() => onUse("copied", field)}
												/>
											</>
										)}
									</div>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</section>
	);
}
