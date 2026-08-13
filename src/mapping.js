function findAnswer(attendee, questionMatch) {
  const hit = attendee.answers.find(
    (a) => a.question.trim().toLowerCase() === questionMatch.trim().toLowerCase()
  );
  return hit ? hit.answer : undefined;
}

export function buildMergeFields(attendee, mergeFieldMap) {
  const merge = {};
  for (const rule of mergeFieldMap) {
    let value;
    if (rule.source === "firstName") value = attendee.firstName;
    else if (rule.source === "lastName") value = attendee.lastName;
    else if (rule.source === "question") value = findAnswer(attendee, rule.match);

    if (value !== undefined && value !== null && value !== "") {
      // Mailchimp merge field values must be strings for text-type fields.
      merge[rule.mergeTag] = Array.isArray(value) ? value.join(", ") : String(value);
    }
  }
  return merge;
}

export function buildTags(attendee, tagRules, eventName) {
  const tags = new Set();

  for (const rule of tagRules) {
    if (rule.type === "static") {
      tags.add(rule.tag);
    } else if (rule.type === "eventName" && eventName) {
      tags.add(`${rule.prefix || ""}${eventName}`);
    } else if (rule.type === "questionAnswer") {
      const answer = findAnswer(attendee, rule.match);
      if (answer !== undefined && answer !== null && answer !== "") {
        const values = Array.isArray(answer) ? answer : [answer];
        for (const v of values) {
          tags.add(`${rule.prefix || ""}${v}`);
        }
      }
    } else if (rule.type === "questionAnswerEquals") {
      const answer = findAnswer(attendee, rule.match);
      if (answer !== undefined) {
        const values = (Array.isArray(answer) ? answer : [answer]).map((v) =>
          String(v).toLowerCase()
        );
        const wanted = (rule.valueEquals || []).map((v) => String(v).toLowerCase());
        if (values.some((v) => wanted.includes(v))) {
          tags.add(rule.tag);
        }
      }
    }
  }

  return Array.from(tags);
}
