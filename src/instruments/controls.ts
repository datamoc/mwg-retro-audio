import type { ChoiceControl, ChoiceOption, RangeControl, ToggleControl } from './Instrument.ts';

/** a value held by an instrument, with the function that applies it to the chip when it changes */
export interface Param<T> {
	value: T;
}

export const param = <T>(value: T): Param<T> => ({ value });

type RangeSpec = Omit<RangeControl, 'kind' | 'get' | 'set' | 'defaultValue'>;
type ChoiceSpec = Omit<ChoiceControl, 'kind' | 'get' | 'set' | 'defaultValue' | 'options'>;
type ToggleSpec = Omit<ToggleControl, 'kind' | 'get' | 'set' | 'defaultValue'>;

/**
 * A range control bound to a `Param`: `set` clamps and rounds to the step, stores, then calls `apply`.
 * The default is the value the param holds when the control is made.
 */
export function rangeControl(
	spec: RangeSpec,
	p: Param<number>,
	apply: (value: number) => void = () => {},
): RangeControl {
	const defaultValue = p.value;
	return {
		kind: 'range',
		...spec,
		defaultValue,
		get: () => p.value,
		set(value: number): void {
			const stepped = Math.round((value - spec.min) / spec.step) * spec.step + spec.min;
			const v = Math.min(spec.max, Math.max(spec.min, Number(stepped.toFixed(6))));
			p.value = v;
			apply(v);
		},
	};
}

export function choiceControl(
	spec: ChoiceSpec,
	options: readonly ChoiceOption[],
	p: Param<number>,
	apply: (value: number) => void = () => {},
): ChoiceControl {
	const defaultValue = p.value;
	return {
		kind: 'choice',
		...spec,
		options,
		defaultValue,
		get: () => p.value,
		set(value: number): void {
			if (!options.some((o) => o.value === value)) return;
			p.value = value;
			apply(value);
		},
	};
}

export function toggleControl(
	spec: ToggleSpec,
	p: Param<boolean>,
	apply: (value: boolean) => void = () => {},
): ToggleControl {
	const defaultValue = p.value;
	return {
		kind: 'toggle',
		...spec,
		defaultValue,
		get: () => p.value,
		set(value: boolean): void {
			p.value = Boolean(value);
			apply(p.value);
		},
	};
}

/** options from a list of labels: values 0, 1, 2... */
export const labelled = (labels: readonly string[]): ChoiceOption[] => labels.map((label, value) => ({ value, label }));
