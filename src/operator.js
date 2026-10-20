// Who runs this Jobbflo, for the privacy policy and the terms. From the
// host's settings, never written into the repository: the operator's
// name and address are personal data too.
export const operatör = () => ({
  namn: process.env.JOBBFLO_OPERATOR || '[operatörens namn saknas — sätt JOBBFLO_OPERATOR]',
  epost: process.env.JOBBFLO_KONTAKT || '[kontaktadress saknas — sätt JOBBFLO_KONTAKT]',
});
