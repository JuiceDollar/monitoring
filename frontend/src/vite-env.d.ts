/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_API_BASE_URL?: string;
	readonly VITE_DEPLOYMENT_ENV?: string;
	readonly VITE_RPC_URL?: string;
	readonly VITE_WAGMI_ID?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
