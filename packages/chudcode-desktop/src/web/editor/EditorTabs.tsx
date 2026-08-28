import { AlertTriangle, GitCompare, RotateCcw, Save, X } from "lucide-react";
import type { DocumentUri } from "../../protocol";

export interface EditorTab {
	uri: DocumentUri;
	label: string;
	dirty: boolean;
	conflict: boolean;
}

interface EditorTabsProps {
	tabs: readonly EditorTab[];
	activeUri?: DocumentUri;
	onSelect(uri: DocumentUri): void;
	onClose(uri: DocumentUri): void;
	onSave(uri: DocumentUri): void;
	onReload(uri: DocumentUri): void;
	onCompare(uri: DocumentUri): void;
}

export function EditorTabs({ tabs, activeUri, onSelect, onClose, onSave, onReload, onCompare }: EditorTabsProps) {
	return (
		<div className="editor-tabs" role="tablist" aria-label="Open files">
			{tabs.map(tab => (
				<div
					key={tab.uri}
					className={`editor-tab ${activeUri === tab.uri ? "is-active" : ""} ${tab.conflict ? "has-conflict" : ""}`}
				>
					<button
						type="button"
						role="tab"
						aria-selected={activeUri === tab.uri}
						title={tab.uri}
						className="editor-tab__select"
						onClick={() => onSelect(tab.uri)}
					>
						<span className="editor-tab__label">{tab.label}</span>
						{tab.conflict ? (
							<span className="editor-tab__conflict" title="File changed on disk">
								<AlertTriangle size={13} /> conflict
							</span>
						) : null}
						{tab.dirty ? (
							<span
								className="editor-tab__dirty motion-tab-dirty"
								aria-label="Unsaved changes"
								title="Unsaved changes"
							/>
						) : null}
					</button>
					{tab.conflict ? (
						<div className="editor-tab__conflict-actions">
							<button
								type="button"
								title="Compare local changes with disk"
								aria-label={`Compare ${tab.label}`}
								onClick={() => onCompare(tab.uri)}
							>
								<GitCompare size={13} />
							</button>
							<button
								type="button"
								title="Reload from disk and discard local changes"
								aria-label={`Reload ${tab.label}`}
								onClick={() => onReload(tab.uri)}
							>
								<RotateCcw size={13} />
							</button>
						</div>
					) : null}
					{tab.dirty && !tab.conflict ? (
						<button
							type="button"
							className="editor-tab__save"
							title="Save"
							aria-label={`Save ${tab.label}`}
							onClick={() => onSave(tab.uri)}
						>
							<Save size={13} />
						</button>
					) : null}
					<button
						type="button"
						className="editor-tab__close motion-tab-close"
						title="Close"
						aria-label={`Close ${tab.label}`}
						onClick={() => onClose(tab.uri)}
					>
						<X size={13} />
					</button>
				</div>
			))}
		</div>
	);
}
