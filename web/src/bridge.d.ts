/** Android 外壳桥(pi-writer-android 的 WebView 注入;桌面浏览器/Electron 不存在,前端走回退路径)。 */
export {};

declare global {
	interface Window {
		/** Kotlin 侧注入的分享桥(Task 1.6 提供);shareZip 存在时,导出书 zip 改走系统分享面板。 */
		PiWriterBridge?: {
			shareZip?: (name: string, dataUrl: string) => void;
		};
	}
}
