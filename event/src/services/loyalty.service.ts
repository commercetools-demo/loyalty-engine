import { ByProjectKeyRequestBuilder } from '@commercetools/platform-sdk/dist/declarations/src/generated/client/by-project-key-request-builder';
import { ConversionRateRow } from '../types/index.types';
import { logger } from '../utils/logger.utils';

/** Custom object container for loyalty conversion rates. */
export const LOYALTY_CONTAINER = 'LOYALTY_CONTAINER';
/** Custom object key for conversion rates. */
export const CONVERSION_RATES_KEY = 'CONVERSION_RATES';
/** Customer custom field name for available points. */
export const AVAILABLE_POINTS_KEY = 'availablePoints';
/** Customer custom type key for loyalty (additional-customer-info). */
export const CUSTOMER_LOYALTY_CUSTOM_TYPE = 'additional-customer-info';
/** Order state key that indicates cancellation (reverse points). */
export const CANCELLED_STATE_KEY = 'Cancelled';

/**
 * Fetches the loyalty conversion rates from the custom object
 * (container: LOYALTY_CONTAINER, key: CONVERSION_RATES).
 */
export async function getConversionRates(
  apiRoot: ByProjectKeyRequestBuilder
): Promise<ConversionRateRow[]> {
  const { body } = await apiRoot
    .customObjects()
    .withContainerAndKey({
      container: LOYALTY_CONTAINER,
      key: CONVERSION_RATES_KEY,
    })
    .get()
    .execute();

  const value = body.value as unknown;
  if (!Array.isArray(value)) {
    logger.warn('Conversion rates custom object value is not an array');
    return [];
  }
  const rows = value as ConversionRateRow[];
  if (
    !rows.every(
      (r) =>
        typeof r.currency === 'string' &&
        typeof r.currencyCentAmount === 'number' &&
        typeof r.pointAmount === 'number'
    )
  ) {
    logger.warn('Conversion rates array has invalid row shape');
    return [];
  }
  return rows;
}

/**
 * Converts a currency amount (in cents) to loyalty points using the conversion table.
 * Uses floor rounding. Returns 0 if no rate found for the currency.
 */
export function currencyToPoints(
  centAmount: number,
  currencyCode: string,
  conversionRates: ConversionRateRow[]
): number {
  const rate = conversionRates.find(
    (r) => r.currency.toUpperCase() === currencyCode.toUpperCase()
  );
  if (!rate || rate.currencyCentAmount <= 0) {
    logger.debug(`No conversion rate for currency ${currencyCode}`);
    return 0;
  }
  return Math.floor((centAmount / rate.currencyCentAmount) * rate.pointAmount);
}

/**
 * Sums loyalty points from all payments on the order (amountPlanned per payment).
 */
export async function getPointsFromPayments(
  order: {
    paymentInfo?: { payments?: Array<{ id?: string }> };
  },
  apiRoot: ByProjectKeyRequestBuilder,
  conversionRates: ConversionRateRow[]
): Promise<number> {
  const payments = order.paymentInfo?.payments ?? [];
  let totalPoints = 0;
  for (const ref of payments) {
    const id = ref.id ?? (ref as { id?: string }).id;
    if (!id) continue;
    try {
      const { body: payment } = await apiRoot
        .payments()
        .withId({ ID: id })
        .get()
        .execute();
      const amount = payment.amountPlanned;
      if (amount && typeof amount.centAmount === 'number') {
        const currency =
          (amount as { currencyCode?: string }).currencyCode ??
          (amount as { currency?: string }).currency;
        if (currency) {
          totalPoints += currencyToPoints(
            amount.centAmount,
            currency,
            conversionRates
          );
        }
      }
    } catch (err) {
      logger.warn(`Failed to fetch payment ${id}: ${err}`);
    }
  }
  return totalPoints;
}

/**
 * Checks if a CartDiscount is a point redemption for the given order cart.
 * Custom fields: isPointRedemption or isPointRedemtion (boolean), and
 * referenceCart or referenceCartId (text, cart id) matching order.cart.id.
 */
function isPointRedemptionDiscount(
  cartDiscount: { custom?: { fields?: Record<string, unknown> } },
  orderCartId: string | undefined
): boolean {
  if (!orderCartId) return false;
  const fields = cartDiscount.custom?.fields ?? {};
  const isRedemption =
    fields.isPointRedemption === true || fields.isPointRedemtion === true;
  if (!isRedemption) return false;
  const refCart =
    (fields.referenceCart as string) ?? (fields.referenceCartId as string);
  return refCart === orderCartId;
}

/**
 * Gets the discount amount in currency from a discount value (e.g. AbsoluteCartDiscountValue).
 */
function getDiscountCentAmount(value: {
  type?: string;
  money?: { centAmount?: number; currencyCode?: string };
}): number {
  if (value.type === 'absolute' && value.money) {
    return value.money.centAmount ?? 0;
  }
  return 0;
}

/**
 * Sums loyalty points to deduct for point-redemption discounts applied on the order.
 * Uses order.discountOnTotalPrice.includedDiscounts and/or order.directDiscounts.
 */
export async function getPointRedemptionPointsToDeduct(
  order: {
    cart?: { id?: string };
    directDiscounts?: Array<{
      id?: string;
      value?: { type?: string; money?: { centAmount?: number; currencyCode?: string } };
    }>;
    discountOnTotalPrice?: {
      includedDiscounts?: Array<{
        discount?: { typeId?: string; id?: string };
        discountedAmount?: { centAmount?: number; currencyCode?: string };
      }>;
    };
  },
  apiRoot: ByProjectKeyRequestBuilder,
  conversionRates: ConversionRateRow[]
): Promise<number> {
  const orderCartId = order.cart?.id;
  let totalPointsToDeduct = 0;

  // 1. Use includedDiscounts when present (per-discount amounts)
  const includedDiscounts =
    order.discountOnTotalPrice?.includedDiscounts ?? [];
  for (const portion of includedDiscounts) {
    const discountRef = portion.discount;
    if (!discountRef) continue;
    const typeId = discountRef.typeId ?? (discountRef as { typeId?: string }).typeId;
    const discountId = discountRef.id ?? (discountRef as { id?: string }).id;
    if (!discountId) continue;

    if (typeId === 'cart-discount') {
      try {
        const { body: cartDiscount } = await apiRoot
          .cartDiscounts()
          .withId({ ID: discountId })
          .get()
          .execute();
        if (
          isPointRedemptionDiscount(
            cartDiscount as { custom?: { fields?: Record<string, unknown> } },
            orderCartId
          )
        ) {
          const amount = portion.discountedAmount;
          if (amount && typeof amount.centAmount === 'number') {
            const currency =
              (amount as { currencyCode?: string }).currencyCode ??
              (amount as { currency?: string }).currency;
            if (currency) {
              totalPointsToDeduct += currencyToPoints(
                amount.centAmount,
                currency,
                conversionRates
              );
            }
          }
        }
      } catch (err) {
        logger.warn(`Failed to fetch cart discount ${discountId}: ${err}`);
      }
    }
    // direct-discount: we could try resolving by id as cart-discount (some setups use same id)
    if (typeId === 'direct-discount') {
      try {
        const { body: cartDiscount } = await apiRoot
          .cartDiscounts()
          .withId({ ID: discountId })
          .get()
          .execute();
        if (
          isPointRedemptionDiscount(
            cartDiscount as { custom?: { fields?: Record<string, unknown> } },
            orderCartId
          )
        ) {
          const amount = portion.discountedAmount;
          if (amount && typeof amount.centAmount === 'number') {
            const currency =
              (amount as { currencyCode?: string }).currencyCode ??
              (amount as { currency?: string }).currency;
            if (currency) {
              totalPointsToDeduct += currencyToPoints(
                amount.centAmount,
                currency,
                conversionRates
              );
            }
          }
        }
      } catch {
        // Not a cart discount id, skip
      }
    }
  }

  // 2. If no includedDiscounts, fall back to directDiscounts value (amount only; no cart discount ref in API)
  if (includedDiscounts.length === 0 && (order.directDiscounts?.length ?? 0) > 0) {
    for (const dd of order.directDiscounts ?? []) {
      const centAmount = getDiscountCentAmount(dd.value ?? {});
      if (centAmount > 0 && dd.id) {
        try {
          const { body: cartDiscount } = await apiRoot
            .cartDiscounts()
            .withId({ ID: dd.id })
            .get()
            .execute();
          if (
            isPointRedemptionDiscount(
              cartDiscount as { custom?: { fields?: Record<string, unknown> } },
              orderCartId
            )
          ) {
            const value = dd.value;
            const currency =
              (value?.money as { currencyCode?: string })?.currencyCode ??
              (value?.money as { currency?: string })?.currency;
            if (currency) {
              totalPointsToDeduct += currencyToPoints(
                centAmount,
                currency,
                conversionRates
              );
            }
          }
        } catch {
          // Direct discount id may not be a cart discount id
        }
      }
    }
  }

  return totalPointsToDeduct;
}

/**
 * Returns the current available points from the customer's custom field.
 * If the field is missing, returns 0. Customer should use custom type with availablePoints (number).
 */
export function getCurrentAvailablePoints(customer: {
  custom?: { fields?: Record<string, unknown> };
}): number {
  const value = customer.custom?.fields?.[AVAILABLE_POINTS_KEY];
  if (value === undefined || value === null) return 0;
  const n = Number(value);
  return Number.isInteger(n) ? n : Math.floor(n);
}
