import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playbookMention, playbookUserId, discordChannelUrl, cleanPlaybookLink, playbookLegLine, playbookText, playbookKey } from '../docs/playbook.js';

test('playbookText writes the tag and the book on the first line, then a leg per line with its game', () => {
  const legs = [
    { selection: 'Jayson Tatum Over 27.5 Points', game: 'Boston Celtics @ New York Knicks' },
    { selection: 'Elena Rybakina Over 3.5 Aces', game: 'Elena Rybakina vs Iga Swiatek' },
    { selection: '', game: 'x' },
  ];
  assert.equal(playbookText({ legs, book: 'fanatics' }), '@Playbook Fanatics\nJayson Tatum Over 27.5 Points (Boston Celtics @ New York Knicks)\nElena Rybakina Over 3.5 Aces (Elena Rybakina vs Iga Swiatek)');
  assert.equal(playbookText({ legs: legs.slice(0, 1), book: 'hardrock', mention: '123456789012' }).split('\n')[0], '<@123456789012> Hard Rock Bet');
  assert.equal(playbookText({ legs: legs.slice(0, 1), book: 'Some Book' }).split('\n')[0], '@Playbook Some Book');
  assert.equal(playbookText({ legs: [], book: 'fanduel' }), '', 'no legs, no message');
  assert.equal(playbookLegLine({ selection: 'Lakers ML', game: 'Lakers @ Celtics' }), 'Lakers ML (Lakers @ Celtics)');
  assert.equal(playbookLegLine({ selection: 'Lakers @ Celtics Over 224.5', game: 'Lakers @ Celtics' }), 'Lakers @ Celtics Over 224.5', 'a game already in the selection is not repeated');
});

test('the mention is a real ping only with the bot\'s user id; the channel link must be Discord; the slip link must be playbookbot.com', () => {
  assert.equal(playbookMention(null), '@Playbook');
  assert.equal(playbookMention('<@!123456789>'), '<@123456789>');
  assert.equal(playbookUserId('abc'), null); assert.equal(playbookUserId('1234'), null, 'too short to be a snowflake');
  assert.equal(discordChannelUrl('https://discord.com/channels/111/222'), 'https://discord.com/channels/111/222');
  assert.equal(discordChannelUrl('https://discord.gg/abc'), 'https://discord.gg/abc');
  assert.equal(discordChannelUrl('https://evil.com/discord.com'), null); assert.equal(discordChannelUrl('javascript:alert(1)'), null); assert.equal(discordChannelUrl(''), null);
  assert.equal(cleanPlaybookLink('here you go https://playbookbot.com/b/AbC123?ref=x.'), 'https://playbookbot.com/b/AbC123?ref=x');
  assert.equal(cleanPlaybookLink('https://sportsbook.fanduel.com/addToBetslip?x=1'), null, 'a book link is not a Playbook link');
  assert.equal(cleanPlaybookLink(''), null);
  assert.equal(playbookKey('Fanatics', ['b', 'a']), 'fanatics|a+b');
});
