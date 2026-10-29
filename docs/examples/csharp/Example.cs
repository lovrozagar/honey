// A C# program against an SDK generated from the Kitchen example API: a client, a call and its typed error, its
// `client.Safe` twin's Result, and an event stream released by `await using`. Compiled by csc against the generated
// SDK in the docs' tests.
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using HoneySdk;

public static class Example
{
    public static HoneySdkClient NewClient() => new(new ClientConfig
    {
        BaseUrl = "https://api.example.com",
        BearerToken = Environment.GetEnvironmentVariable("KITCHEN_TOKEN"),
        Timeout = TimeSpan.FromSeconds(10),
    });

    public static async Task<string?> CheckHealth(HoneySdkClient client)
    {
        try
        {
            await client.GetApiHealthAsync();
            return null;
        }
        catch (ApiStatusException failed)
        {
            return $"health check answered {failed.Status}";
        }
    }

    public static async Task<string> Listing(HoneySdkClient client, string id)
    {
        var result = await client.Safe.GetApiAsync(id); // no answer (never sent, refused, timed out, canceled) still throws
        return result.Match(
            found => $"answered {result.Response.Status}: {found}",
            error => error switch
            {
                DecodeException unreadable => $"answered {result.Response.Status}, unreadable: {unreadable.Message}",
                ApiStatusException failed => $"answered {failed.Status}: {failed.Key}",
                _ => error.Message,
            });
    }

    public static async Task<List<string>> FirstEvents(HoneySdkClient client, int limit)
    {
        var seen = new List<string>();
        await using var stream = await client.GetApiEventsAsync(); // disposing it frees the connection
        await foreach (var ev in stream)
        {
            seen.Add(ev.Data);
            if (seen.Count == limit) break;
        }
        return seen;
    }

    public static async Task Main(string[] args)
    {
        if (args.Length < 1) return;
        using var client = NewClient();
        Console.WriteLine(await CheckHealth(client));
        Console.WriteLine(await Listing(client, args[0]));
        Console.WriteLine(string.Join(",", await FirstEvents(client, 2)));
    }
}
