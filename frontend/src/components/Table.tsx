import { useState, useMemo } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { colors, spacing, typography } from '../lib/theme';

export enum Alignment {
	LEFT = 'left',
	RIGHT = 'right',
	CENTER = 'center',
}

export interface MultiLineCell {
	primary: ReactNode;
	secondary?: ReactNode;
	primaryClass?: string;
	secondaryClass?: string;
}

export interface Column<T> {
	header: { primary: string; secondary?: string };
	align?: Alignment;
	format: (row: T) => ReactNode | MultiLineCell;
}

interface TableProps<T> {
	title: string;
	data?: T[];
	sort?: (a: T, b: T) => number;
	error?: string;
	columns: Column<T>[];
	getRowKey: (row: T) => string;
	hidden?: (row: T) => boolean;
	emptyMessage?: string;
	onExport?: () => void;
}

export function Table<T>({ title, data, sort, error, columns, getRowKey, hidden, emptyMessage = 'No data found', onExport }: TableProps<T>) {
	const [showHidden, setShowHidden] = useState(false);

	const sortedData = useMemo(() => (data && sort ? [...data].sort(sort) : data), [data, sort]);
	const filteredData = useMemo(
		() => (hidden && !showHidden ? sortedData?.filter((row) => !hidden(row)) : sortedData),
		[sortedData, hidden, showHidden]
	);
	const hiddenCount = useMemo(() => (hidden ? sortedData?.filter(hidden).length : 0), [sortedData, hidden]);

	return error ? (
		<EmptyTable title={title} message={`Error: ${error}`} />
	) : !filteredData?.length && (!hiddenCount || !showHidden) ? (
		<EmptyTable title={title} message={emptyMessage} hiddenCount={hiddenCount} setShowHidden={setShowHidden} />
	) : (
		<div className={`${colors.background} ${colors.table.border} border rounded-xl`}>
			{/* table top bar */}
			<div
				className={`${spacing.cellPadding} ${colors.table.border} border-b rounded-t-xl ${colors.table.headerBg} flex items-center justify-between`}
			>
				<h2 className={`text-sm ${typography.tableHeader} ${colors.text.primary}`}>
					{title} ({filteredData?.length})
				</h2>
				<div className="flex gap-3 items-center">
					{onExport && (
						<button
							onClick={onExport}
							className={`text-xs ${colors.text.secondary} hover:text-gray-300 transition-colors cursor-pointer`}
							title="Export to CSV"
						>
							↓ CSV
						</button>
					)}
					<button
						hidden={!hiddenCount}
						onClick={() => setShowHidden((prev) => !prev)}
						className={`text-xs ${colors.text.secondary} hover:text-gray-300 transition-colors cursor-pointer`}
					>
						{showHidden ? `Hide ${hiddenCount}` : `Show ${hiddenCount} more`}
					</button>
				</div>
			</div>

			{/* table */}
			<div className="overflow-x-auto">
				<table className="w-full text-sm">
					<thead>
						{/* headers */}
						<tr className={`${colors.table.border} border-b`}>
							{columns.map((column, index) => {
								const align = column.align || Alignment.LEFT;
								const alignClass =
									align === Alignment.RIGHT ? 'text-right' : align === Alignment.CENTER ? 'text-center' : 'text-left';
								return (
									<th
										key={index}
										className={`${spacing.cellPadding} ${alignClass} ${typography.tableHeader} ${colors.text.secondary}`}
									>
										<div className={spacing.compact}>
											<div>{column.header.primary}</div>
											{column.header.secondary && <div className={colors.text.muted}>{column.header.secondary}</div>}
										</div>
									</th>
								);
							})}
						</tr>
					</thead>
					{/* rows (body) */}
					<tbody>
						{filteredData?.map((row) => {
							const isHidden = hidden?.(row) || false;
							const rowClass = isHidden ? colors.table.rowDim : '';
							return (
								<tr key={getRowKey(row)} className={`${colors.table.border} border-b ${colors.table.rowHover} ${rowClass}`}>
									{columns.map((column, index) => (
										<td key={index} className={`${spacing.cellPadding} ${typography.value}`}>
											<CellContent column={column} row={row} isHidden={isHidden} />
										</td>
									))}
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</div>
	);
}

interface EmptyTableProps {
	title: string;
	message: string;
	hiddenCount?: number;
	setShowHidden?: Dispatch<SetStateAction<boolean>>;
}

function EmptyTable({ title, message, hiddenCount, setShowHidden }: EmptyTableProps) {
	return (
		<div className={`${colors.background} ${colors.table.border} border rounded-xl`}>
			<div
				className={`${spacing.cellPadding} ${colors.table.border} border-b rounded-t-xl ${colors.table.headerBg} flex items-center justify-between`}
			>
				<h2 className={`text-sm ${typography.tableHeader} ${colors.text.primary}`}>{title}</h2>
				<button
					hidden={!hiddenCount || !setShowHidden}
					onClick={() => setShowHidden && setShowHidden((prev) => !prev)}
					className={`text-xs ${colors.text.secondary} hover:text-gray-300 transition-colors cursor-pointer`}
				>
					Show {hiddenCount} more
				</button>
			</div>
			<div className={`${spacing.cellPadding} ${colors.text.secondary}`}>{message}</div>
		</div>
	);
}

interface CellContentProps<T> {
	column: Column<T>;
	row: T;
	isHidden: boolean;
}

function CellContent<T>({ column, row, isHidden }: CellContentProps<T>): ReactNode {
	const content = column.format(row);
	const align = column.align || Alignment.LEFT;
	const alignClass = align === Alignment.RIGHT ? 'text-right' : align === Alignment.CENTER ? 'text-center' : 'text-left';
	if (content && typeof content === 'object' && 'primary' in content) {
		const cellContent = content as MultiLineCell;
		return (
			<div className={`${spacing.compact} ${alignClass}`}>
				<div className={cellContent.primaryClass || (isHidden ? colors.text.secondary : colors.text.primary)}>
					{cellContent.primary}
				</div>
				{cellContent.secondary && (
					<div className={cellContent.secondaryClass || colors.text.secondary}>{cellContent.secondary}</div>
				)}
			</div>
		);
	}

	return <div className={`${alignClass} ${isHidden ? colors.text.secondary : colors.text.primary}`}>{content}</div>;
}
