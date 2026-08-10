/**
 * Parsing for `/edit` command arguments.
 */

export interface EditArgs {
	/** Enable vim-style editing instead of the default simple editor. */
	vim: boolean;
	/** File path relative to the book directory, empty for the default draft. */
	path: string;
	/** 绕过 .writer/ 与 outline.md 的只读保护,强制打开。 */
	force: boolean;
}

export function parseEditArgs(raw: string): EditArgs {
	let input = raw.trim();
	let force = false;
	// --force 可出现在任意位置;剥离后其余解析逻辑不变
	const forceRe = /(^|\s)--force(?=\s|$)/;
	while (forceRe.test(input)) {
		force = true;
		input = input.replace(forceRe, "$1").replace(/\s{2,}/g, " ").trim();
	}
	if (input === "--vim" || input === "vim") {
		return { vim: true, path: "", force };
	}
	if (input.startsWith("--vim ")) {
		return { vim: true, path: input.slice("--vim ".length).trim(), force };
	}
	if (input.startsWith("vim ")) {
		return { vim: true, path: input.slice("vim ".length).trim(), force };
	}
	return { vim: false, path: input, force };
}
