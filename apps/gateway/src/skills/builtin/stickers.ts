import type { Skill } from '@jian/contracts';

export const stickers: Skill = {
  name: 'stickers',
  description:
    'Use when someone sends you a sticker, when a chat is playful and a reaction would fit better than words, or when asked to send, find or tag a sticker.',
  instructions: `# Stickers

A sticker is a reaction, not a message. People send one to laugh, agree, tease, celebrate,
sympathise or close a topic without words. Read one that way, and send one only when a person
would.

## Reading a sticker someone sent

It arrives as \`[Sticker]\` with its image (on Telegram, with its emoji too). Answer what it
means in the moment, not what it shows: a laughing sticker after your joke means it landed; a
thumbs up after your plan means go ahead; a facepalm after your mistake means you got it
wrong. Often the right answer to a sticker is a short line, or a sticker back — rarely a
paragraph.

## When one fits

- The chat is light: jokes, banter, celebrating, a friendly goodbye.
- The person or the group uses stickers themselves. Mirror them: where nobody sends stickers,
  you do not either.
- A reaction says it better than a sentence: agreeing, laughing along, "done".

## When one does not

- Anything serious: bad news, a complaint, a problem, grief, health, money, a conflict.
- Someone is waiting for an answer: the answer comes first, in words.
- Someone new, or a formal conversation, or anything the owner treats as work unless they
  use stickers there themselves.
- Twice in a row, or in most of your messages. One now and then is warmth; many is noise.

When in doubt, do not. Nothing is lost by not sending one.

## Choosing one

The tools are in the \`media\` group; load it with \`load_tools\`.

- \`find_stickers\` with a \`query\` finds by meaning: search for the reaction you want to
  give ("laughing", "approving", "tired"), not for keywords of the conversation.
- \`tag\` narrows to an exact tag, when you know the one you mean.
- \`order: "most_seen"\` lists what the people you talk to send most: their style, and usually
  the safest choice in that chat. \`"most_sent"\` lists your own favourites.
- Pick the one whose feeling matches, not the one that merely mentions the subject. If none
  fits well, send words instead.

\`send_sticker\` sends it — here, or in another of your conversations with its \`sessionId\`,
when someone here asks you to send one there. A sticker goes alone: anything you need to say goes in a message of
its own, before it.

## Tags

Every sticker gets tags when it is first kept: the feeling, the reaction, the subject. When
you learn how one is really used in a chat — "they send this one to end an argument" — or its
tags miss what it is, \`tag_sticker\` replaces them. Short, lowercase, the words you would
search for next time.

The collection is what people sent in approved chats: you cannot fetch new stickers from
anywhere else. Sticker analysis is controlled under **Model defaults**.`,
};
