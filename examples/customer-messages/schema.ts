// The questions the checked labels in data/labels.jsonl answer. Two streams, a schema each:
// messages customers write to a home-service business, and texts the business's owner writes
// to Remy, the assistant in the software they run the business on.
import { choice, defineSchema, score, yesNo } from "../../src/index.ts";

/** Asked of every message a customer (or would-be customer) writes to a business. */
export const customer = defineSchema({
  name: "customer",
  questions: {
    asks_for_work: yesNo("Is the sender asking the business to do new work for them, or to quote or estimate new work?"),
    asks_price: yesNo("Does the sender ask how much something costs?"),
    visit_change: choice("What does the sender want done about a visit or appointment?", {
      none: "Nothing about a visit",
      book: "Book a new visit or pick a time",
      reschedule: "Move an existing visit to another time",
      cancel: "Cancel a visit or the job",
      confirm: "Confirm or ask about the time of a visit already booked",
    }),
    complaint: yesNo("Is the sender unhappy with the business, its work, its price or its timing?"),
    work_problem: yesNo("Does the sender say something is wrong with work the business already did?"),
    payment_dispute: yesNo("Does the sender say they will dispute a charge, ask their bank for a chargeback, refuse to pay, or that they were charged wrongly?"),
    price_objection: yesNo("Does the sender say a price or quote is too high, or ask for a discount?"),
    urgency: score("How soon does the business need to act on this message?", ["No rush", "Within a few days", "Today", "Right now: an emergency"]),
    safety_or_damage: yesNo("Does the message mention a danger to people or property, such as a gas smell, flooding, sparks, a fire, an injury or damage the work caused?"),
    legal_threat: yesNo("Does the sender threaten a lawyer, a lawsuit, small claims court, a licensing board, the BBB or a bad public review?"),
    praise: yesNo("Does the sender thank the business or say they are happy with its work?"),
    stop_texting: yesNo("Does the sender ask the business to stop contacting them altogether?"),
  },
});

/** Asked of every text an owner sends the assistant. */
export const owner = defineSchema({
  name: "owner",
  questions: {
    frustrated_with_assistant: yesNo("Is the sender annoyed, confused or frustrated with Remy, the assistant they are texting?"),
    churn_risk: yesNo("Does the sender say they want to cancel, stop paying for, or switch away from Acme?"),
  },
});
