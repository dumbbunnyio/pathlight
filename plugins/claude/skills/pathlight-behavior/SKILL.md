---
name: pathlight-behavior
description: Use when the user wants a state diagram or flow of what a user sees or what a feature does ("draw the flow", "statechart", "what should happen when...", "how does a request move through the system"), to find where a flow breaks, or to mark which states are broken or fixed in pathlight. Writes a behavior view (states) or a journey (a dynamic view through the real components) in a *.behavior.c4 file and shows it with pathlight.
---

# pathlight behavior

A behavior view answers "what should happen, step by step?" It is a state diagram you write from reading the code, drawn in the same LikeC4 workspace as the architecture and opened with `pathlight show`. The architecture map is scanned from the code; this is not. It is **your reading of the code**, so say so, and never present it as verified.

## Truthfulness

- A behavior view is a claim, not an observation. Every state and transition must come from code you read, and each state names the files it comes from (see below). Do not invent a state to make the picture complete. Leave a gap and say what you could not find.
- Finding a bug means reasoning through the transitions and seeing one that gives the wrong result for the user, or a combination of events nobody handled. Say what you traced and what you did not. A formal checker (TLA+ or another) finds more, but it is optional and you must not assume one is installed.
- Never change product code because a diagram looks wrong unless the user asks. Report the bug in plain words, as the steps that lead to it.

## Where it goes

Write one file per flow in the folder of the LikeC4 project it belongs to (`.pathlight/` for the model `pathlight draft` writes), named `NAME.behavior.c4` (for example `messages.behavior.c4`). `pathlight draft` leaves these alone, so a rerun never loses them. If the project has no model at all, ask before creating `likec4.config.json` and `pathlight.activity.json` in `.pathlight/` (see the pathlight skill).

Put one flow in one `flow` element, tagged `#behavior`, with its states inside it, and name the flow after what it is (`signup`), because top-level ids are shared with the generated architecture model and a clash stops it compiling. Declare `tag behavior` in the file's `specification`, as the example does: it keeps the flow out of the architecture views. Avoid LikeC4 reserved words as ids (`storage`, `notation`, `model`, `view`, `style`, `group`).

```likec4
specification {
  element flow
  element state
  element decision
  tag behavior
  tag bug
  tag fixed
}
model {
  signup = flow 'Signing up' {
    #behavior
    start = state 'Someone opens the sign-up page' {
      description 'src/web/signup.ts'
    }
    taken = decision 'Is the email already used?'
    error = state 'They see "email taken"' {
      #fixed
      description 'src/web/signup.ts, src/api/users.ts'
    }
    created = state 'Account created, welcome email sent'
    double = state 'Two accounts exist for one email' {
      #bug
      description 'Two requests at once both pass the check. src/api/users.ts'
    }
    start -> taken 'submits the form'
    taken -> error 'yes'
    taken -> created 'no'
    taken -> double 'no, and a second request arrives first'
  }
}
views {
  view signup of signup {
    title 'What happens when someone signs up'
    description 'Agent-written from src/api/users.ts and src/web/signup.ts. Synced at 3f2a9c1.'
    include *
    autoLayout TopBottom
  }
}
```

## How to draw it

1. **States are what the person sees**, in their words ("Your phone buzzes after you opened it"), not function names. A state is a place the flow rests; a `decision` is a question with two or more answers.
2. **Transitions are the events**, written on the arrow as the title ("you walk away without reading it"). One transition per cause. If one cause can lead to two states, draw a decision.
3. **Start from the real code path.** Read the handlers and follow each branch. Draw the ordinary path first, then the unusual ones (retries, two things at once, going offline, an expired session).
4. **Keep it small.** Roughly 8 to 25 boxes. Split a flow that needs more into two views linked with `navigateTo`.
5. **Say where each state lives.** Put the files in its `description`, as the example does. This is how someone reviewing the diagram opens the code.

## Marking findings

- A state the user should not be able to reach, or that gives the wrong result, gets `#bug`. Its description says in one sentence why it happens.
- Once the code is changed and you have read the changed code, add a `#fixed` state next to it showing the corrected outcome, linked from the bug with a transition titled `with the fix`. Leave the `#bug` state in so the history reads.
- No tag means "traced, and it works". It does not mean tested.

pathlight draws `#bug` boxes with a red outline and `#fixed` ones green.

## Journeys: how a request moves through the components

A state diagram says what a person sees. A **journey** says which components a request passes through, in order, and pathlight draws it on the architecture itself. It is a LikeC4 `dynamic view` over components the model already has, one step per hop, each titled with the event.

### Which model traces (hosts where the person has several models)

Claude Code pins the tracer to Sonnet itself, so skip this there. In OpenCode and any host with a `pathlight_models` tool, call it before the first trace. It reports the model the tracer will use and why. If `tracer.source` is `sonnet` or `option`, say which model in one line and carry on. If it is `none`, nothing tested is available to this person: do not pick a model yourself. Show them `usable` (the models they can use, with prices), name at most two that look like a fair step down from their current model for reading code, say that none has been measured for this (only Sonnet-class models have, docs/eval.md), and ask which they want, or to keep their current model. After they answer, set `options.tracerModel` as `provider/model` on the pathlight plugin entry in `opencode.json`, tell them to reload OpenCode, and note the choice in your reply. On a flat-rate plan a cheaper model may save nothing, so "keep my current model" is a real answer.

### Working it out

The story comes from reading the code. If a `pathlight-tracer` agent is available (the Claude plugin ships one, pinned to a mid-size model), hand the whole job to it: give it the component, the question and the files, let it run the steps below and write the journey, then pass on its report, including what it left out and anything `pathlight flows` flagged. Reading ten files is work a large conversation model should not spend its tokens on, and the files stay out of the conversation. Do not hand it to a smaller model than that: a smaller one did not do this reliably in testing. If there is no such agent, do the steps yourself, in this order, and do not skip the second:

1. **Trace the path.** Pick the entry point (a route, a command, a handler, the thing the person clicks). Follow it through the code and list, in order, the files it passes through, which component each belongs to (`pathlight list --workspace .` and the model give the ids) and the call that leads to the next. Hand back facts and file names, no claims about what they mean. `pathlight scan` lists the imports if a map is needed.
2. **Decide.** Open the files yourself: any trace you were handed is a list of leads, not facts. Confirm each hop is really in the code, settle the order and the event on each arrow, and drop any hop you cannot point to in a file. If the code is unclear, leave the hop out and say so. Say where the story and the model disagree: a hop the code makes and the model has no relationship for (the command prints it) means the model may be missing a relationship, so name it for the person, and do not add the relationship yourself to silence the warning.
3. **Write it with the command, not by hand.**

```sh
pathlight flow add place-order --workspace . \
  --title 'Placing an order' \
  --reads src/web/checkout.ts,src/api/checkout.ts \
  --step 'customer -> parcel.storefront: opens checkout' \
  --step 'parcel.storefront -> parcel.commerce.api: submits the cart' \
  --step 'parcel.commerce.api -> parcel.commerce.orders: commits the order'
```

`pathlight flow add` checks every component against the model (and offers the nearest id when one is mistyped), requires the files you read, stamps the view with the commit, writes `place-order.behavior.c4` (in the folder of the LikeC4 project it is for; pass `--project NAME` when the repository has several), takes the file back out if the model would stop compiling, and prints what `pathlight flows` finds. Use `--force` to replace one it wrote and `pathlight flow remove place-order` to delete it; it never overwrites or removes a file a person or agent wrote by hand. The command writes down your reading; it does not make the reading right.

If you must write the view by hand (for example to combine it with a state diagram in one file), this is the shape:

```likec4
views {
  dynamic view placeorder {
    title 'Placing an order'
    description 'Agent-written from src/web/checkout.ts and src/api/checkout.ts. Synced at 3f2a9c1.'
    customer -> parcel.storefront 'opens checkout'
    parcel.storefront -> parcel.commerce.api 'submits the cart'
    parcel.commerce.api -> parcel.commerce.orders 'commits the order'
  }
}
```

- Put it in the same `*.behavior.c4` file as the state diagram it belongs to, or its own; `pathlight draft` leaves those files alone.
- Every hop should be a relationship the model already has. A hop it does not have is shown with `≠ no relationship in the model` and listed by `pathlight flows`: that is the story and the model disagreeing, so say which one you think is wrong instead of adding the relationship to make the warning go away.
- Name the files you read in the `description`, and the commit (`Synced at <short sha>`). A journey is your reading of the code, drawn in the agent's colour and labelled so; it never says what happened.
- The person traces it with `F` in the viewer (`[` `]` to step, `esc` to leave) and sees which components the agent has touched along it. Mark nothing as passed or failed: observed calls are shown beside the steps and are not part of the flow.

## Keeping it true

- Write the commit you read the code at into the view's `description` (`Synced at <short sha>`), as the example does. Get it with `git rev-parse --short HEAD`.
- Before using or extending a behavior view, run `pathlight flows --workspace .`. It lists, per flow, files a state names that are gone or changed since the sync commit, arrows with no event, decisions with fewer than two answers, states nothing reaches, and states that name no file (those cannot be checked at all); and, per journey, hops the model has no relationship for and components whose files changed since the sync commit. If anything changed, re-read those parts and update the view, and only then move the sync commit forward. A clean report means the diagram has not visibly drifted from the files it names, not that it is right.
- Say plainly when you did not do that: "this diagram was last checked at <sha>".

## Show it

`pathlight show VIEW --workspace . --follow` with the view id (`signup` above). `pathlight list --workspace .` lists every view. The relationship titles (the events) appear in the inspector under Connections when a box is selected; the diagram itself draws no text on arrows, so make each state name read on its own.
