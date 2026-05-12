import { DEPLOYMENT_ENV, resolveChain, TELEGRAM_BOT } from '../constants';

export function Footer() {
	const botUrl = TELEGRAM_BOT[resolveChain()][DEPLOYMENT_ENV];

	return (
		<footer className="border-t border-neutral-800 mt-8">
			<div className="max-w-7xl mx-auto px-4 py-6 flex items-center justify-end gap-3 text-sm">
				<a
					href={botUrl}
					target="_blank"
					rel="noreferrer noopener"
					title="Telegram alerts bot"
					aria-label="Telegram alerts bot"
					className="inline-flex items-center gap-2 text-gray-400 hover:text-gray-100 transition-colors"
				>
					<TelegramIcon className="w-5 h-5" />
					<span>Get alerts</span>
				</a>
			</div>
		</footer>
	);
}

function TelegramIcon({ className = '' }: { className?: string }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			className={`fill-current ${className}`}
			aria-hidden="true"
		>
			<path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z" />
		</svg>
	);
}
