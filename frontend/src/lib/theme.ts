export const colors = {
	// Base colors
	background: 'bg-neutral-950',
	text: {
		primary: 'text-gray-100', // White on black
		secondary: 'text-gray-500', // Dim gray for secondary info
		muted: 'text-neutral-600', // Even more muted
	},

	// Semantic colors
	highlight: 'text-[#FFFF00]', // Bright yellow for highlighting
	critical: 'text-red-400', // Red for important/critical
	success: 'text-green-400', // Green for positive
	link: 'text-[#FFFF00]', // Bright yellow for links/addresses

	// Table specific
	table: {
		border: 'border-neutral-900', // Subtle borders
		headerBg: 'bg-neutral-900', // Slightly different header
		rowHover: 'hover:bg-neutral-900', // Subtle hover
		rowDim: 'opacity-50', // For dimmed/closed rows
	},
} as const;

// Consistent spacing
export const spacing = {
	cellPadding: 'px-3 py-2',
	sectionGap: 'space-y-6',
	compact: 'space-y-1',
} as const;

// Typography
export const typography = {
	mono: 'font-mono',
	tableHeader: 'text-xs uppercase tracking-wider font-normal',
	value: 'tabular-nums', // For better number alignment
} as const;
