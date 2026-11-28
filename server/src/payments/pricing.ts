/*
 * Country-aware pricing.
 *
 * Plan prices are defined in INR (base unit : ₹2,000 / month for Pro).
 * Each country maps to a currency with a per-INR minor-unit rate, so a user in
 * the US sees ~US$24.10/month while an Indian user sees ₹2,000/month. The
 * checkout stores the amount in the user's own currency - Razorpay handles
 * INR (UPI / cards), PayPal handles international currencies.
 */

export interface CountryInfo {
  iso2: string;
  name: string;
  currency: string;
  symbol: string;
  /** minor units of this currency per 1 INR (e.g. USD cents, JPY yen) */
  unitsPerInr: number;
  /** Decimal digits used when storing prices for this currency. */
  digits: number;
}

export const COUNTRIES: CountryInfo[] = [
  { iso2: "IN", name: "India", currency: "INR", symbol: "₹", unitsPerInr: 100, digits: 2 },
  { iso2: "US", name: "United States", currency: "USD", symbol: "$", unitsPerInr: 1.20482, digits: 2 },
  { iso2: "GB", name: "United Kingdom", currency: "GBP", symbol: "£", unitsPerInr: 0.95238, digits: 2 },
  { iso2: "AE", name: "United Arab Emirates", currency: "AED", symbol: "AED", unitsPerInr: 4.40885, digits: 2 },
  { iso2: "SA", name: "Saudi Arabia", currency: "SAR", symbol: "SR", unitsPerInr: 4.50664, digits: 2 },
  { iso2: "QA", name: "Qatar", currency: "QAR", symbol: "QR", unitsPerInr: 4.42478, digits: 2 },
  { iso2: "OM", name: "Oman", currency: "OMR", symbol: "RO", unitsPerInr: 0.4643, digits: 3 },
  { iso2: "BH", name: "Bahrain", currency: "BHD", symbol: "BD", unitsPerInr: 0.45113, digits: 3 },
  { iso2: "KW", name: "Kuwait", currency: "KWD", symbol: "KD", unitsPerInr: 0.36609, digits: 3 },
  { iso2: "EU", name: "European Union", currency: "EUR", symbol: "€", unitsPerInr: 1.11111, digits: 2 },
  { iso2: "DE", name: "Germany", currency: "EUR", symbol: "€", unitsPerInr: 1.11111, digits: 2 },
  { iso2: "FR", name: "France", currency: "EUR", symbol: "€", unitsPerInr: 1.11111, digits: 2 },
  { iso2: "NL", name: "Netherlands", currency: "EUR", symbol: "€", unitsPerInr: 1.11111, digits: 2 },
  { iso2: "IT", name: "Italy", currency: "EUR", symbol: "€", unitsPerInr: 1.11111, digits: 2 },
  { iso2: "ES", name: "Spain", currency: "EUR", symbol: "€", unitsPerInr: 1.11111, digits: 2 },
  { iso2: "IE", name: "Ireland", currency: "EUR", symbol: "€", unitsPerInr: 1.11111, digits: 2 },
  { iso2: "SG", name: "Singapore", currency: "SGD", symbol: "S$", unitsPerInr: 1.62608, digits: 2 },
  { iso2: "MY", name: "Malaysia", currency: "MYR", symbol: "RM", unitsPerInr: 5.68182, digits: 2 },
  { iso2: "TH", name: "Thailand", currency: "THB", symbol: "฿", unitsPerInr: 43.4783, digits: 2 },
  { iso2: "ID", name: "Indonesia", currency: "IDR", symbol: "Rp", unitsPerInr: 192.308, digits: 0 },
  { iso2: "VN", name: "Vietnam", currency: "VND", symbol: "₫", unitsPerInr: 303.03, digits: 0 },
  { iso2: "PH", name: "Philippines", currency: "PHP", symbol: "₱", unitsPerInr: 69.4444, digits: 2 },
  { iso2: "PK", name: "Pakistan", currency: "PKR", symbol: "₨", unitsPerInr: 336.7, digits: 2 },
  { iso2: "BD", name: "Bangladesh", currency: "BDT", symbol: "৳", unitsPerInr: 142.857, digits: 2 },
  { iso2: "NP", name: "Nepal", currency: "NPR", symbol: "₨", unitsPerInr: 161.29, digits: 2 },
  { iso2: "LK", name: "Sri Lanka", currency: "LKR", symbol: "₨", unitsPerInr: 400, digits: 2 },
  { iso2: "EG", name: "Egypt", currency: "EGP", symbol: "E£", unitsPerInr: 59.0, digits: 2 },
  { iso2: "KE", name: "Kenya", currency: "KES", symbol: "KSh", unitsPerInr: 155.0, digits: 2 },
  { iso2: "NG", name: "Nigeria", currency: "NGN", symbol: "₦", unitsPerInr: 2000, digits: 2 },
  { iso2: "ZA", name: "South Africa", currency: "ZAR", symbol: "R", unitsPerInr: 22.2222, digits: 2 },
  { iso2: "AU", name: "Australia", currency: "AUD", symbol: "A$", unitsPerInr: 1.81818, digits: 2 },
  { iso2: "NZ", name: "New Zealand", currency: "NZD", symbol: "NZ$", unitsPerInr: 2.0, digits: 2 },
  { iso2: "CA", name: "Canada", currency: "CAD", symbol: "C$", unitsPerInr: 1.63934, digits: 2 },
  { iso2: "JP", name: "Japan", currency: "JPY", symbol: "¥", unitsPerInr: 1.81818, digits: 0 },
  { iso2: "CN", name: "China", currency: "CNY", symbol: "CN¥", unitsPerInr: 8.77193, digits: 2 },
  { iso2: "CH", name: "Switzerland", currency: "CHF", symbol: "CHF", unitsPerInr: 1.08696, digits: 2 },
  { iso2: "SE", name: "Sweden", currency: "SEK", symbol: "kr", unitsPerInr: 12.6582, digits: 2 },
  { iso2: "NO", name: "Norway", currency: "NOK", symbol: "kr", unitsPerInr: 12.8205, digits: 2 },
  { iso2: "DK", name: "Denmark", currency: "DKK", symbol: "kr", unitsPerInr: 8.26446, digits: 2 },
  { iso2: "BR", name: "Brazil", currency: "BRL", symbol: "R$", unitsPerInr: 6.90069, digits: 2 },
  { iso2: "MX", name: "Mexico", currency: "MXN", symbol: "Mex$", unitsPerInr: 23.2558, digits: 2 },
  { iso2: "TR", name: "Türkiye", currency: "TRY", symbol: "₺", unitsPerInr: 41.6667, digits: 2 },
  { iso2: "RU", name: "Russia", currency: "RUB", symbol: "₽", unitsPerInr: 111.111, digits: 2 },
];

const COUNTRY_MAP = new Map(COUNTRIES.map((c) => [c.iso2, c]));

export function countryInfo(iso2: string | undefined | null): CountryInfo {
  return COUNTRY_MAP.get((iso2 || "IN").toUpperCase()) ?? COUNTRY_MAP.get("IN")!;
}

export function currencyDigits(currency: string): number | undefined {
  return COUNTRIES.find(country => country.currency === currency)?.digits;
}

/** Plan base price per month, in INR main units (₹2,000 / ₹4,000). */
export const BASE_INR_AMOUNT: Record<string, number> = {
  pro: 2000,
  studio: 4000,
};

/** Local price (minor units of the user's currency) for a plan. */
export function localPriceMinor(iso2: string | undefined | null, planId: string): number {
  const info = countryInfo(iso2);
  return Math.round((BASE_INR_AMOUNT[planId] ?? 0) * info.unitsPerInr);
}
