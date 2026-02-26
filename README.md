<p align="center">
  <a href="https://commercetools.com/">
    <img alt="commercetools logo" src="https://unpkg.com/@commercetools-frontend/assets/logos/commercetools_primary-logo_horizontal_RGB.png">
  </a></br>
  <b>Connect Application Starter in TypeScript</b>
</p>

This is the `starter-typescript` template to develop [connect applications](https://marketplace.commercetools.com/) in TypeScript.

## Instructions

Use `create-connect-app` cli with `starter-typescript` as `template` value to download this template repository to build the integration application , folder structure needs to be followed to ensure certification & deployment from commercetools connect team as stated [here](https://github.com/commercetools/connect-application-kit#readme) 

## Architecture principles for building an connect application 

* Connector solution should be lightweight in nature
* Connector solutions should follow test driven development. Unit , Integration (& E2E) tests should be included and successfully passed to be used
* No hardcoding of customer related config. If needed, values in an environment file which should not be maintained in repository
* Connector solution should be supported with detailed documentation
* Connectors should be point to point in nature, currently doesnt support any persistence capabilities apart from in memory persistence
* Connector solution should use open source technologies, although connector itself can be private for specific customer(s)
* Code should not contain console.log statements, use [the included logger](https://github.com/commercetools/merchant-center-application-kit/tree/main/packages-backend/loggers#readme) instead.

---

## Loyalty Engine – Required Commercetools Configuration

The event app implements a loyalty engine that awards points from order payments and deducts points for point-redemption discounts. The following custom types, fields, and custom objects must exist in your Commercetools project.

### Custom types

| Resource   | Type key                    | Purpose                                      |
|-----------|-----------------------------|----------------------------------------------|
| Customer  | `additional-customer-info`  | Stores loyalty points on the customer.       |
| CartDiscount | `additional-discount-info` | Marks point-redemption discounts and cart reference. |

### Custom type fields

**Customer** (type key: `additional-customer-info`)

| Field name       | Type   | Description                                      |
|------------------|--------|--------------------------------------------------|
| `availablePoints` | Number | Current loyalty points balance. Set to 0 if missing. |

**CartDiscount** (type key: `additional-discount-info`)

| Field name          | Type    | Description                                                                 |
|---------------------|---------|-----------------------------------------------------------------------------|
| `isPointRedemtion`  | Boolean | When `true`, this discount is a point redemption (also accept `isPointRedemption`). |
| `referenceCart`     | String  | Cart ID; points are only deducted when this equals the order’s `cart.id`.  |

### Custom object (conversion rates)

| Container           | Key               | Value shape                                                                 |
|---------------------|-------------------|-----------------------------------------------------------------------------|
| `LOYALTY_CONTAINER` | `CONVERSION_RATES` | JSON array of objects: `{ "currency": "USD", "currencyCentAmount": 100, "pointAmount": 1 }` |

Example value:

```json
[
  { "currency": "USD", "currencyCentAmount": 100, "pointAmount": 1 },
  { "currency": "EUR", "currencyCentAmount": 100, "pointAmount": 1 }
]
```

- `currency`: ISO 4217 currency code.
- `currencyCentAmount`: amount in the smallest currency unit (e.g. cents) that corresponds to `pointAmount` points.
- `pointAmount`: number of loyalty points for that currency amount.

### Order state (cancellation)

| State key   | Purpose                                                                 |
|------------|-------------------------------------------------------------------------|
| `Cancelled` | When an order transitions to this state, the engine reverses loyalty: subtracts payment points and adds back redemption points. |

### API scopes

The subscription and API client need at least: `view_orders`, `view_customers`, `manage_customers`, `view_payments`, `view_cart_discounts`, and `view_custom_objects` (or equivalent for custom objects).
