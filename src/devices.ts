// Public names and colours for the devices that report usage. Collectors identify themselves by
// device id; the server maps each id to a public name here, before anything is published.
// Which devices exist and what they are called is the DeviceConfig the server is given.

export type DeviceInfo = { name: string; color: string };

export type DeviceConfig = {
	/** Known devices by id, in display order. */
	devices: Record<string, DeviceInfo>;
	/**
	 * Devices whose id is not listed above:
	 * - `'by-id'` (default): shown under their own id, with the next free palette colour.
	 * - `'other'`: merged into one "Other" line, so no device id is ever published. Use this
	 *   when ids are hostnames you'd rather keep private.
	 */
	unknownDevices?: 'by-id' | 'other';
};

export type ResolvedDevice = DeviceInfo & { order: number };

export const OTHER: DeviceInfo = { name: 'Other', color: '#97a098' };

// Colours for devices without one. Validated with the dataviz palette checks (normal vision and
// CVD) against each other and the dark chart surface (#121614). Cycles after the last one.
export const PALETTE = ['#7fa034', '#3899e2', '#d77343', '#a03fa7'];

/** Maps every reporting device id to its public name, colour and display order. */
export function resolveDevices(ids: Iterable<string>, config: DeviceConfig) {
	const out = new Map<string, ResolvedDevice>();
	const known = Object.entries(config.devices);
	known.forEach(([id, info], order) => out.set(id, { ...info, order }));

	const unknown = [...new Set(ids)].filter((id) => !Object.hasOwn(config.devices, id)).sort();
	if (config.unknownDevices === 'other') {
		for (const id of unknown) out.set(id, { ...OTHER, order: Number.MAX_SAFE_INTEGER });
		return out;
	}
	const used = new Set(known.map(([, info]) => info.color.toLowerCase()));
	const free = PALETTE.filter((c) => !used.has(c.toLowerCase()));
	const colors = free.length ? free : PALETTE;
	unknown.forEach((id, i) =>
		out.set(id, { name: id, color: colors[i % colors.length], order: known.length + i })
	);
	return out;
}
