export type OtpPurpose = "login" | "safety";

export type OtpDelivery = {
  verificationCode: string;
  response: {
    sent: boolean;
    delivery: "development" | "sms";
    devCode?: string;
    message: string;
  };
};

export interface OtpDeliveryProvider {
  issue(phone: string, purpose: OtpPurpose): OtpDelivery;
}

export class OtpProviderUnavailableError extends Error {}

export function createOtpProvider({ development, developmentCode }: { development: boolean; developmentCode: string }): OtpDeliveryProvider {
  if (!development) {
    return {
      issue() {
        throw new OtpProviderUnavailableError("SMS delivery is not configured in this build. No code was sent.");
      },
    };
  }

  return {
    issue() {
      return {
        verificationCode: developmentCode,
        response: {
          sent: false,
          delivery: "development",
          devCode: developmentCode,
          message: "Development code generated locally. No SMS was sent.",
        },
      };
    },
  };
}
