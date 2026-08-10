/**
 * pi-writer public API.
 *
 * Build a writing-focused agent on top of pi-coding-agent by composing the
 * writer system prompt, word_count tool, book/chapter manager, and inline
 * extension exported here. See packages/pi-writer/README.md.
 */

export {
	addChapter,
	type BookIndex,
	type BookListEntry,
	type ChapterRef,
	createBook,
	ensureBook,
	getBookSessionsDir,
	getChapterSessionsPath,
	initChapterFile,
	listBooks,
	loadBook,
	resolveChapter,
	setCurrentChapter,
	updateChapter,
} from "./book-manager.ts";
export {
	APP_NAME,
	APP_TITLE,
	getAgentDir,
	getBookDir,
	getBookIndexPath,
	getBooksDir,
	getChapterFile,
	getWriterDir,
	slugify,
	VERSION,
} from "./config.ts";
export { writerExtension } from "./extension.ts";
export { WRITER_SYSTEM_PROMPT } from "./prompt.ts";
export { wordCountTool } from "./tools.ts";
