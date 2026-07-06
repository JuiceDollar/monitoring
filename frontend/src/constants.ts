export type DeploymentEnv = 'prd' | 'dev';

const rawDeploymentEnv = import.meta.env.VITE_DEPLOYMENT_ENV;
if (rawDeploymentEnv !== 'prd' && rawDeploymentEnv !== 'dev') {
	throw new Error(`VITE_DEPLOYMENT_ENV must be "prd" or "dev" (got: "${rawDeploymentEnv}")`);
}
export const DEPLOYMENT_ENV: DeploymentEnv = rawDeploymentEnv;

export const TELEGRAM_BOT = {
	mainnet: {
		prd: 'https://t.me/juicedollar_monitor_prd_bot',
		dev: 'https://t.me/juicedollar_monitor_dev_bot',
	},
} as const;
