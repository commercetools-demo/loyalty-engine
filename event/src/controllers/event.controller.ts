import { Request, Response } from 'express';
import { createApiRoot } from '../client/create.client';
import CustomError from '../errors/custom.error';
import { logger } from '../utils/logger.utils';
import {
  getConversionRates,
  getRedemptionRates,
  getPointsFromPayments,
  getPointRedemptionPointsToDeduct,
  getCurrentAvailablePoints,
  AVAILABLE_POINTS_KEY,
  CUSTOMER_LOYALTY_CUSTOM_TYPE,
  CANCELLED_STATE_KEY,
} from '../services/loyalty.service';
import { ByProjectKeyRequestBuilder } from '@commercetools/platform-sdk/dist/declarations/src/generated/client/by-project-key-request-builder';
import type { CustomerUpdateAction } from '@commercetools/platform-sdk';

/**
 * Exposed event POST endpoint.
 * Receives the Pub/Sub message and works with it (order events for loyalty engine).
 */
export const post = async (request: Request, response: Response) => {
  if (!request.body) {
    logger.error('Missing request body.');
    throw new CustomError(400, 'Bad request: No Pub/Sub message was received');
  }

  if (!request.body.message) {
    logger.error('Missing body message');
    throw new CustomError(400, 'Bad request: Wrong Pub/Sub message format');
  }

  const pubSubMessage = request.body.message;
  const decodedData = pubSubMessage.data
    ? Buffer.from(pubSubMessage.data, 'base64').toString().trim()
    : undefined;

  if (!decodedData) {
    throw new CustomError(400, 'Bad request: No data in the Pub/Sub message');
  }

  const jsonData = JSON.parse(decodedData);

  if (jsonData.notificationType === 'ResourceCreated') {
    throw new CustomError(
      202,
      'Incoming message is about subscription resource creation. Skip handling the message.'
    );
  }

  const messageType = jsonData.type;
  const orderId = jsonData.order?.id ?? jsonData.resource?.id;

  if (!orderId) {
    throw new CustomError(400, 'Bad request: No order id in the Pub/Sub message');
  }

  try {
    const apiRoot = createApiRoot();

    if (messageType === 'OrderCreated') {
      logger.info(`Handling OrderCreated event for orderId: ${orderId}`);
      await handleOrderCreated(orderId, apiRoot);
    } else if (messageType === 'OrderStateChanged') {
      const orderState = jsonData.orderState;
      if (orderState) {
        
        if (orderState === CANCELLED_STATE_KEY) {
          logger.info(
            `Handling order cancellation for orderId: ${orderId} (state: ${orderState})`
          );
          await handleOrderCancelled(orderId, apiRoot);
        } else {
          logger.info(
            `OrderStateChanged for orderId: ${orderId} to state ${orderState}; no loyalty action.`
          );
        }
      } else {
        logger.info(`OrderStateTransition for orderId: ${orderId} without state id; skip.`);
      }
    } else {
      logger.info(`Unhandled message type: ${messageType} for orderId: ${orderId}`);
    }
  } catch (error) {
    logger.error('error', error);
  }

  response.status(204).send();
};

/**
 * Handles OrderCreated: add points from payment amounts, deduct points for point-redemption discounts,
 * then update customer availablePoints in a single update.
 */
async function handleOrderCreated(
  orderId: string,
  apiRoot: ByProjectKeyRequestBuilder
): Promise<void> {
  const {
    body: order,
  } = await apiRoot.orders().withId({ ID: orderId }).get().execute();

  if (!order.customerId) {
    logger.info(`Order ${orderId} has no customerId (anonymous); skip loyalty.`);
    return;
  }

  const conversionRates = await getConversionRates(apiRoot);
  if (conversionRates.length === 0) {
    logger.warn('No conversion rates; skip loyalty for order ' + orderId);
    return;
  }

  const redemptionRates = await getRedemptionRates(apiRoot);

  const pointsFromPayments = await getPointsFromPayments(
    order as Parameters<typeof getPointsFromPayments>[0],
    apiRoot,
    conversionRates
  );

  const pointsToDeduct = await getPointRedemptionPointsToDeduct(
    order as Parameters<typeof getPointRedemptionPointsToDeduct>[0],
    apiRoot,
    redemptionRates
  );


  const {
    body: customer,
  } = await apiRoot
    .customers()
    .withId({ ID: order.customerId })
    .get({
      queryArgs: {
        expand: ['custom.type'],
      },
    })
    .execute();


  const currentPoints = getCurrentAvailablePoints(
    customer as Parameters<typeof getCurrentAvailablePoints>[0]
  );
  const newPoints = Math.max(0, currentPoints + pointsFromPayments - pointsToDeduct);

  const actions: CustomerUpdateAction[] = [];
  if (!customer.custom?.type?.id || customer.custom?.type?.obj?.key !== CUSTOMER_LOYALTY_CUSTOM_TYPE) {
    actions.push({
      action: 'setCustomType',
      type: { typeId: 'type', key: CUSTOMER_LOYALTY_CUSTOM_TYPE },
    });
  }
  actions.push({
    action: 'setCustomField',
    name: AVAILABLE_POINTS_KEY,
    value: newPoints,
  });

  await apiRoot
    .customers()
    .withId({ ID: order.customerId })
    .post({
      body: {
        version: customer.version,
        actions,
      },
    })
    .execute();

  logger.info(
    `Order ${orderId}: added ${pointsFromPayments} points, deducted ${pointsToDeduct} (redemption); customer ${order.customerId} availablePoints: ${currentPoints} -> ${newPoints}`
  );
}

/**
 * Handles order cancellation: subtract points that had been added from payment, add back points that had been deducted for redemptions.
 */
async function handleOrderCancelled(
  orderId: string,
  apiRoot: ByProjectKeyRequestBuilder
): Promise<void> {
  const {
    body: order,
  } = await apiRoot.orders().withId({ ID: orderId }).get().execute();

  if (!order.customerId) {
    logger.info(`Order ${orderId} has no customerId; skip loyalty reversal.`);
    return;
  }

  const conversionRates = await getConversionRates(apiRoot);
  if (conversionRates.length === 0) {
    logger.warn('No conversion rates; skip loyalty reversal for order ' + orderId);
    return;
  }

  const redemptionRates = await getRedemptionRates(apiRoot);

  const pointsFromPayments = await getPointsFromPayments(
    order as Parameters<typeof getPointsFromPayments>[0],
    apiRoot,
    conversionRates
  );
  const pointsToAddBack = await getPointRedemptionPointsToDeduct(
    order as Parameters<typeof getPointRedemptionPointsToDeduct>[0],
    apiRoot,
    redemptionRates
  );

  const {
    body: customer,
  } = await apiRoot
    .customers()
    .withId({ ID: order.customerId })
    .get()
    .execute();

  const currentPoints = getCurrentAvailablePoints(
    customer as Parameters<typeof getCurrentAvailablePoints>[0]
  );
  const newPoints = Math.max(
    0,
    currentPoints - pointsFromPayments + pointsToAddBack
  );

  const actions: CustomerUpdateAction[] = [];
  if (!customer.custom?.type?.id) {
    actions.push({
      action: 'setCustomType',
      type: { typeId: 'type', key: CUSTOMER_LOYALTY_CUSTOM_TYPE },
    });
  }
  actions.push({
    action: 'setCustomField',
    name: AVAILABLE_POINTS_KEY,
    value: newPoints,
  });

  await apiRoot
    .customers()
    .withId({ ID: order.customerId })
    .post({
      body: {
        version: customer.version,
        actions,
      },
    })
    .execute();

  logger.info(
    `Order ${orderId} cancelled: reversed ${pointsFromPayments} points, added back ${pointsToAddBack} (redemption); customer ${order.customerId} availablePoints: ${currentPoints} -> ${newPoints}`
  );
}
