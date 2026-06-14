/**
 * Optional fake auth flow — a clearly-mock OTP verify. There is no real session
 * (the demo is stateless per call); this just models a deterministic
 * verify-the-code response so the agent-usage story has a sign-in beat.
 */
import { CUSTOMER, MOCK_OTP } from "@/data/index.js";

export interface AuthResult {
  ok: boolean;
  message: string;
  customerName?: string;
}

/** Verify the (always 000000) demo OTP for the seeded customer. Deterministic. */
export function verifyOtp(otp: string): AuthResult {
  if (otp.trim() === MOCK_OTP) {
    return {
      ok: true,
      message: `Signed in as ${CUSTOMER.name} (demo).`,
      customerName: CUSTOMER.name,
    };
  }
  return {
    ok: false,
    message: `Wrong code. The demo OTP is ${MOCK_OTP}.`,
  };
}
