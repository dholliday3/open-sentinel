// The support example's questions: what you might ask of every message sent to a support inbox.
// Deliberately general. No question names a specific bug: an incident nobody predicted has to
// show up as a shift in these broad signals, and group-by plus the investigator find the rest.
import { choice, defineSchema, score, yesNo } from "../../src/index.ts";

export const support = defineSchema({
  name: "support",
  questions: {
    area: choice("Which part of the product is the message about?", {
      login_access: "Signing in, passwords, accounts, teammates' access",
      billing_plan: "Their Acme plan, subscription or charges from Acme",
      payments_payouts: "Taking card payments from their customers, payouts, Stripe",
      invoices_estimates: "Invoices or estimates they send their customers",
      scheduling_booking: "The schedule, visits, or their online booking page",
      website: "Their website or domain",
      google_profile: "Their Google Business Profile or reviews",
      texting_calls: "Their business phone number, texts or calls",
      assistant: "Remy, the AI assistant",
      other: "Anything else",
    }),
    is_bug_report: yesNo("Does the customer say something in the product isn't working as it should?"),
    blocked: yesNo("Does the customer say they can't get their work done until this is fixed?"),
    how_to: yesNo("Is the customer asking how to do something?"),
    // Answering this needs product knowledge the text doesn't carry, so a decision model leans yes
    // on "can I...?" questions; only a clear request counts.
    feature_request: yesNo("Is the customer asking for something the product doesn't do yet?", { gate: 0.7 }),
    price_complaint: yesNo("Does the customer complain about Acme's price or what Acme charged them?"),
    churn_intent: yesNo("Does the customer say they want to cancel, downgrade or leave Acme?"),
    // "Someone else can see theirs" matched an owner's own office manager; "outside their business" doesn't.
    data_exposure: yesNo("Does the customer say they can see another business's customers or information, or that someone outside their business got into their account?"),
    praise: yesNo("Does the customer say they are happy with Acme?"),
    frustration: score("How frustrated is the customer?", ["Not at all", "A little", "Clearly frustrated", "Furious"]),
  },
  state: (event) => ({ product: "Acme, software for home-service businesses", written_by: "a business owner using Acme", message: event.text }),
});
