export type Message = {
  code: string;
  message: string;
  referencedBy: string;
};

export type ValidatorCreator = (
  path: string[],
  message: Message,
  overrideConfig?: object
) => [string[], [[(o: object) => boolean, string, [object]]]];

export type ValidatorFunction = (o: object) => boolean;

export type Wrapper = (
  validator: ValidatorFunction
) => (value: object) => boolean;

/** One row from the loyalty conversion rates custom object (LOYALTY_CONTAINER / CONVERSION_RATES). */
export interface ConversionRateRow {
  currency: string;
  currencyCentAmount: number;
  pointAmount: number;
}
