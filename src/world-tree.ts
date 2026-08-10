import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WORLD_FILES, type WorldEntry } from "./world-data.ts";

/**
 * World-book tree parsing and rendering helpers.
 *
 * The world-book is a set of Markdown files inside a book directory:
 *   - .writer/characters.md  (kind: "character")
 *   - .writer/world.md       (kind: "world")
 *   - .writer/timeline.md    (kind: "timeline")
 *   - outline.md             (kind: "outline")
 *
 * Each Markdown heading (`#`, `##`, `###`) becomes a node. The first `#`
 * heading in a file is its root; `##`/`###` headings attach to that root
 * unless they carry an explicit `parent: <title>` metadata line, in which
 * case they attach to the named sibling heading instead. Parsing is
 * defensive: missing files yield no nodes, never crashes.
 */

export interface WorldNode {
	/** Stable id: `<fileRel>:<title>`. */
	id: string;
	/** Heading text without the leading `#` markers. */
	title: string;
	/** Which world-book file this node came from. */
	kind: "character" | "world" | "timeline" | "outline";
	/** Parent node title, or null for a file root. */
	parent: string | null;
	/** Body text under the heading (metadata `parent:` lines stripped). */
	body: string;
	/** Linked child nodes. */
	children: WorldNode[];
	/** Repo-relative path of the source file, e.g. `.writer/characters.md`. */
	fileRel: string;
}

const KIND_ICONS: Record<WorldNode["kind"], string> = {
	character: "📖",
	world: "🌍",
	timeline: "⏱",
	outline: "📋",
};

interface RawNode {
	title: string;
	headingLevel: number;
	bodyLines: string[];
	explicitParent: string | null;
}

/** Match a `parent:` metadata line, e.g. `parent: 林婉` or `- parent: 林婉`. */
const PARENT_RE = /^\s*-?\s*parent:\s*(.+?)\s*$/;

/** Match Markdown headings `#`, `##`, `###` (deeper headings are body text). */
const H1_RE = /^#\s+(.+?)\s*$/;
const H2_RE = /^##\s+(.+?)\s*$/;
const H3_RE = /^###\s+(.+?)\s*$/;

function parseFileContent(content: string, kind: WorldNode["kind"], fileRel: string): WorldNode[] {
	const lines = content.split(/\r?\n/);
	const raws: RawNode[] = [];
	let rootTitle: string | null = null;
	let current: RawNode | null = null;

	const flush = (): void => {
		if (!current) return;
		let explicitParent: string | null = null;
		const bodyLines: string[] = [];
		for (const line of current.bodyLines) {
			const m = line.match(PARENT_RE);
			if (m && explicitParent === null) {
				explicitParent = m[1].trim();
			} else {
				bodyLines.push(line);
			}
		}
		raws.push({ ...current, explicitParent });
	};

	for (const line of lines) {
		const h1 = line.match(H1_RE);
		const h2 = line.match(H2_RE);
		const h3 = line.match(H3_RE);
		if (h1 || h2 || h3) {
			flush();
			const title = (h1 ?? h2 ?? h3)![1].trim();
			const headingLevel = h1 ? 1 : h2 ? 2 : 3;
			if (headingLevel === 1 && rootTitle === null) rootTitle = title;
			current = { title, headingLevel, bodyLines: [], explicitParent: null };
		} else if (current) {
			current.bodyLines.push(line);
		}
	}
	flush();

	if (raws.length === 0) return [];

	const nodes: WorldNode[] = raws.map((raw) => {
		let parent: string | null;
		if (raw.headingLevel === 1) {
			parent = null;
		} else if (raw.explicitParent !== null) {
			parent = raw.explicitParent;
		} else {
			parent = rootTitle;
		}
		return {
			id: `${fileRel}:${raw.title}`,
			title: raw.title,
			kind,
			parent,
			body: raw.bodyLines.join("\n").trim(),
			children: [],
			fileRel,
		};
	});

	// Link children within the same file by matching parent titles.
	const byTitle = new Map<string, WorldNode>();
	for (const n of nodes) byTitle.set(n.title, n);
	for (const n of nodes) {
		if (n.parent === null) continue;
		const p = byTitle.get(n.parent);
		if (p) {
			p.children.push(n);
		} else {
			// Named parent not found: treat as a root so it stays visible.
			n.parent = null;
		}
	}

	return nodes;
}

/**
 * Parse the world-book files under `bookDir` into a flat list of `WorldNode`
 * with `children` linked. Missing files contribute no nodes.
 */
export async function parseWorldBook(bookDir: string): Promise<WorldNode[]> {
	const all: WorldNode[] = [];
	for (const { rel, type } of WORLD_FILES) {
		let content: string;
		try {
			content = await readFile(join(bookDir, rel), "utf-8");
		} catch {
			continue;
		}
		all.push(...parseFileContent(content, type, rel));
	}
	return all;
}

interface FlatItem {
	node: WorldNode;
	depth: number;
	isLast: boolean;
	/** For each ancestor level < depth, whether that ancestor was its parent's last child. */
	ancestorLasts: boolean[];
}

/** DFS walk producing display order with tree-connector metadata. */
function flattenTree(nodes: WorldNode[]): FlatItem[] {
	const roots = nodes.filter((n) => n.parent === null);
	const out: FlatItem[] = [];
	const walk = (node: WorldNode, depth: number, isLast: boolean, ancestorLasts: boolean[]): void => {
		out.push({ node, depth, isLast, ancestorLasts });
		const children = node.children;
		for (let i = 0; i < children.length; i++) {
			const child = children[i]!;
			walk(child, depth + 1, i === children.length - 1, [...ancestorLasts, isLast]);
		}
	};
	for (let i = 0; i < roots.length; i++) {
		walk(roots[i]!, 0, i === roots.length - 1, []);
	}
	return out;
}

/** Flatten the linked tree into display order (roots first, then DFS children). */
export function flattenWorldTree(nodes: WorldNode[]): WorldNode[] {
	return flattenTree(nodes).map((item) => item.node);
}

/** Render the tree as indented display lines with box-drawing connectors. */
export function renderWorldTree(nodes: WorldNode[]): string[] {
	return flattenTree(nodes).map(({ node, depth, isLast, ancestorLasts }) => {
		if (depth === 0) {
			return `${KIND_ICONS[node.kind]} ${node.title}`;
		}
		let prefix = "";
		for (let level = 0; level < depth - 1; level++) {
			prefix += ancestorLasts[level] ? "  " : "│ ";
		}
		prefix += isLast ? "└─ " : "├─ ";
		return `${prefix}${node.title}`;
	});
}

/** type → 相对路径(由 WORLD_FILES 唯一真相源派生)。 */
const FILE_REL_BY_KIND = Object.fromEntries(WORLD_FILES.map((f) => [f.type, f.rel])) as Record<
	WorldEntry["type"],
	string
>;

/** JSON 条目 → WorldNode 树(供 TUI /world 与前端列表视图;形状与旧解析一致)。 */
export function renderWorldTreeFromData(entries: WorldEntry[]): WorldNode[] {
	const byId = new Map<string, WorldEntry>();
	for (const e of entries) byId.set(e.id, e);
	const nodes: WorldNode[] = entries.map((e) => ({
		id: e.id,
		title: e.title,
		kind: e.type,
		parent: e.parent,
		body: e.body,
		children: [],
		fileRel: FILE_REL_BY_KIND[e.type],
	}));
	for (const n of nodes) {
		if (n.parent === null) continue;
		const p = byId.get(n.parent);
		if (p) {
			nodes.find((x) => x.id === p.id)?.children.push(n);
		} else {
			// parent 悬空:降级为根(保证可见)
			n.parent = null;
		}
	}
	return nodes;
}
