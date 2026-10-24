import {
	DotsThreeIcon,
	DownloadSimpleIcon,
	FileIcon,
	PaperclipIcon,
	PencilSimpleIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import { Button } from "@vauly/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@vauly/ui/components/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@vauly/ui/components/dropdown-menu";
import { Input } from "@vauly/ui/components/input";
import { type FormEvent, useRef, useState } from "react";
import { useOnline } from "@/lib/connection";
import {
	fileSize,
	type ItemFile,
	useFileActions,
	useFiles,
	useFileUsage,
} from "@/lib/files";
import { ago } from "@/lib/format";
import { errorMessage, type Item } from "@/lib/vault-data";

import { ConfirmDialog } from "./confirm-dialog";
import { notify } from "./notify";

/** The files on an item: anyone who can open it downloads them; editors add and remove. */
export function ItemFiles({
	item,
	editable,
}: {
	item: Item;
	editable: boolean;
}) {
	const files = useFiles(item.id);
	const usage = useFileUsage(editable);
	const actions = useFileActions();
	const online = useOnline();
	const input = useRef<HTMLInputElement>(null);
	const [uploading, setUploading] = useState<{
		name: string;
		done: number;
	} | null>(null);
	const [renaming, setRenaming] = useState<ItemFile | null>(null);
	const [removing, setRemoving] = useState<ItemFile | null>(null);

	const list = files.data ?? [];
	const canAttach =
		editable && !item.deletedAt && (usage.data?.maxTotal ?? 1) > 0;
	if (list.length === 0 && !canAttach) return null;

	const attach = async (chosen: File[]) => {
		// A file chosen as the item opens can come before the limits do.
		const max = (usage.data ?? (await usage.refetch()).data)?.maxFile;
		for (const file of chosen) {
			if (max !== undefined && file.size > max) {
				notify.error(
					`${file.name} is too big`,
					`Files can be up to ${fileSize(max)} here.`,
				);
				continue;
			}
			setUploading({ name: file.name, done: 0 });
			try {
				await actions.upload(item, file, (done) =>
					setUploading({ name: file.name, done }),
				);
				notify.success(`Attached ${file.name}`);
			} catch (err) {
				notify.error(`Couldn't attach ${file.name}`, errorMessage(err));
			}
		}
		setUploading(null);
	};

	const download = async (file: ItemFile) => {
		try {
			await actions.download(file);
		} catch (err) {
			notify.error(
				`Couldn't download ${file.name}`,
				online ? errorMessage(err) : "Files need a connection.",
			);
		}
	};

	return (
		<section
			aria-label="Files"
			className="border-line-subtle mt-2 flex flex-col gap-2 border-t p-4"
		>
			<div className="flex items-center justify-between">
				<h3 className="text-body-sm text-fg">Files</h3>
				{canAttach && (
					<>
						<Button
							variant="ghost"
							size="xs"
							disabled={uploading !== null || !online}
							onClick={() => input.current?.click()}
						>
							<PaperclipIcon data-icon="inline-start" />
							Attach a file
						</Button>
						<input
							ref={input}
							type="file"
							multiple
							hidden
							aria-label="File to attach"
							onChange={(event) => {
								const chosen = [...(event.target.files ?? [])];
								event.target.value = "";
								if (chosen.length) attach(chosen);
							}}
						/>
					</>
				)}
			</div>
			{list.length === 0 && !uploading ? (
				<p className="text-caption text-fg-subtle">
					Attach key files, certificates or PDFs
					{usage.data ? `, up to ${fileSize(usage.data.maxFile)} each` : ""}.
					They're encrypted on this device first.
				</p>
			) : (
				<ul className="flex flex-col gap-1">
					{list.map((file) => (
						<li
							key={file.id}
							className="hover:bg-tint/3 flex items-center gap-2.5 rounded-lg px-2 py-1.5"
						>
							<span className="bg-surface shadow-pill text-fg-muted flex size-7 shrink-0 items-center justify-center rounded-md">
								<FileIcon className="size-4" />
							</span>
							<div className="flex min-w-0 flex-1 flex-col">
								<span className="text-body-sm text-fg truncate">
									{file.name}
								</span>
								<span className="text-caption text-fg-subtle truncate">
									{fileSize(file.size)} · added {ago(file.createdAt)}
								</span>
							</div>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={`Download ${file.name}`}
								onClick={() => download(file)}
							>
								<DownloadSimpleIcon />
							</Button>
							{editable && !item.deletedAt && (
								<DropdownMenu>
									<DropdownMenuTrigger
										render={
											<Button
												variant="ghost"
												size="icon-sm"
												aria-label={`More for ${file.name}`}
											/>
										}
									>
										<DotsThreeIcon />
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="w-40">
										<DropdownMenuItem onClick={() => setRenaming(file)}>
											<PencilSimpleIcon />
											Rename…
										</DropdownMenuItem>
										<DropdownMenuItem
											variant="destructive"
											onClick={() => setRemoving(file)}
										>
											<TrashIcon />
											Remove…
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							)}
						</li>
					))}
					{uploading && (
						<li
							role="status"
							className="text-caption text-fg-muted flex items-center gap-2.5 px-2 py-1.5"
						>
							<span className="bg-surface shadow-pill flex size-7 shrink-0 items-center justify-center rounded-md">
								<PaperclipIcon className="size-4" />
							</span>
							<span className="min-w-0 flex-1 truncate">
								Encrypting and attaching {uploading.name}…{" "}
								{Math.round(uploading.done * 100)}%
							</span>
						</li>
					)}
				</ul>
			)}

			<RenameDialog
				key={renaming?.id}
				file={renaming}
				onOpenChange={(open) => !open && setRenaming(null)}
				onRename={async (file, name) => {
					try {
						await actions.rename(file, item, name);
						notify.success(`Renamed to ${name}`);
						setRenaming(null);
					} catch (err) {
						notify.error("Couldn't rename it", errorMessage(err));
					}
				}}
			/>
			<ConfirmDialog
				open={removing !== null}
				onOpenChange={(open) => !open && setRemoving(null)}
				title={`Remove ${removing?.name ?? "the file"}?`}
				description="It's deleted for good, for everyone who can open this item."
				confirm="Remove"
				destructive
				onConfirm={async () => {
					if (!removing) return;
					try {
						await actions.remove(removing);
						notify.success(`Removed ${removing.name}`);
					} catch (err) {
						notify.error("Couldn't remove it", errorMessage(err));
					}
				}}
			/>
		</section>
	);
}

function RenameDialog({
	file,
	onOpenChange,
	onRename,
}: {
	file: ItemFile | null;
	onOpenChange: (open: boolean) => void;
	onRename: (file: ItemFile, name: string) => Promise<void>;
}) {
	const [name, setName] = useState(file?.name ?? "");
	const [busy, setBusy] = useState(false);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const trimmed = name.trim();
		if (!file || !trimmed) return;
		setBusy(true);
		try {
			await onRename(file, trimmed);
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog open={file !== null} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Rename {file?.name}</DialogTitle>
				</DialogHeader>
				<form className="flex flex-col gap-4" onSubmit={submit}>
					<Input
						aria-label="File name"
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={busy || !name.trim()}>
							Rename
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
