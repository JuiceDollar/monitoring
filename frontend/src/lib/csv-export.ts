export function exportToCSV<T>(
	data: T[],
	columns: { header: string; getValue: (row: T) => string | number }[],
	filename: string
): void {
	// Create CSV header
	const headers = columns.map(col => col.header).join(',');

	// Create CSV rows
	const rows = data.map(row =>
		columns.map(col => {
			const value = col.getValue(row);
			// Escape values that contain commas, quotes, or newlines
			if (typeof value === 'string' && (value.includes(',') || value.includes('"') || value.includes('\n'))) {
				return `"${value.replace(/"/g, '""')}"`;
			}
			return value;
		}).join(',')
	);

	// Combine header and rows
	const csv = [headers, ...rows].join('\n');

	// Create blob and download
	const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
	const link = document.createElement('a');
	const url = URL.createObjectURL(blob);

	link.setAttribute('href', url);
	link.setAttribute('download', filename);
	link.style.visibility = 'hidden';

	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);

	URL.revokeObjectURL(url);
}
