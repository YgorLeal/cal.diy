import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { shouldHideBrandingForEvent } from "@calcom/features/profile/lib/hideBranding";
import prisma from "@calcom/prisma";
import { BookingStatus } from "@calcom/prisma/enums";
import { paymentDataSelect } from "@calcom/prisma/selects/payment";
import { EventTypeMetaDataSchema } from "@calcom/prisma/zod-utils";
import type { GetServerSidePropsContext } from "next";
import { z } from "zod";

const querySchema = z.object({
  uid: z.string(),
});

function hasStringProp<T extends string>(x: unknown, key: T): x is { [key in T]: string } {
  return !!x && typeof x === "object" && key in x;
}

/**
 * Inlined from the removed `@calcom/features/ee/payments` package. Stripe is the
 * only app that needs a client secret, and it stores it on `payment.data`.
 */
function getClientSecretFromPayment(payment: {
  paymentOption?: string | null;
  data: Record<string, unknown>;
}) {
  if (
    payment.paymentOption === "HOLD" &&
    hasStringProp(payment.data, "setupIntent") &&
    hasStringProp(payment.data.setupIntent, "client_secret")
  ) {
    return payment.data.setupIntent.client_secret;
  }
  if (hasStringProp(payment.data, "client_secret")) {
    return payment.data.client_secret;
  }
  return "";
}

export const getServerSideProps = async (context: GetServerSidePropsContext) => {
  const { uid } = querySchema.parse(context.query);
  const session = await getServerSession({ req: context.req });

  const rawPayment = await prisma.payment.findUnique({
    where: { uid },
    // `paymentDataSelect` predates this page: it omits the payment's own id and
    // the booking's `paid` flag, both of which PaymentPage reads.
    select: {
      ...paymentDataSelect,
      id: true,
      booking: {
        select: {
          ...paymentDataSelect.booking.select,
          paid: true,
        },
      },
    },
  });

  if (!rawPayment) return { notFound: true } as const;

  const { data, booking: _booking, ...restPayment } = rawPayment;

  const payment = {
    ...restPayment,
    data: data as Record<string, unknown>,
  };

  if (!_booking) return { notFound: true } as const;

  const { startTime, endTime, eventType, ...restBooking } = _booking;
  const booking = {
    ...restBooking,
    startTime: startTime.toString(),
    endTime: endTime.toString(),
  };

  if (!eventType) return { notFound: true } as const;

  if (eventType.users.length === 0 && !eventType.team) return { notFound: true } as const;

  const [user] = eventType.users.length
    ? eventType.users
    : [{ id: 0, name: null, theme: null, hideBranding: null, username: null }];

  const profile = {
    name: eventType.team?.name || user?.name || null,
    theme: (!eventType.team?.name && user?.theme) || null,
    hideBranding: await shouldHideBrandingForEvent({
      eventTypeId: eventType.id,
      team: eventType.team,
      owner: eventType.users[0] ?? null,
      organizationId: session?.user?.profile?.organizationId ?? session?.user?.org?.id ?? null,
    }),
  };

  if (
    ([BookingStatus.CANCELLED, BookingStatus.REJECTED] as BookingStatus[]).includes(
      booking.status as BookingStatus
    )
  ) {
    return {
      redirect: {
        destination: `/booking/${booking.uid}`,
        permanent: false,
      },
    };
  }

  return {
    props: {
      user,
      eventType: {
        ...eventType,
        metadata: EventTypeMetaDataSchema.parse(eventType.metadata),
      },
      booking,
      payment,
      clientSecret: getClientSecretFromPayment(payment),
      profile,
    },
  };
};
