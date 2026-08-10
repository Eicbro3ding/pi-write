/** Copy a file input selection before resetting the live FileList. */
export function snapshotFiles(list: FileList | null): File[] {
	return list ? Array.from(list) : [];
}
