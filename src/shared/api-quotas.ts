import {
  API_QUOTA_CODE,
  API_QUOTAS,
  GUEST_LINK_EXPIRY_HOURS,
} from "./quotas.js";

export {
  API_QUOTA_CODE,
  API_QUOTAS,
  GUEST_LINK_EXPIRY_HOURS,
};

export type ApiQuotaName = keyof typeof API_QUOTAS;

export interface ApiQuotaDetails {
  actual: number;
  code: typeof API_QUOTA_CODE;
  limit: number;
  quota: ApiQuotaName;
}

export interface ApiQuotaProblem extends ApiQuotaDetails {
  error: string;
}
