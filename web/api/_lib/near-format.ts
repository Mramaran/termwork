/** Formats a yoctoNEAR amount string as a NEAR decimal string without trailing zeros. */
export function yoctoToNear(y: string): string {
  const s = y.padStart(25, "0");
  const whole = s.slice(0, -24);
  const frac = s.slice(-24).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
