// A Go program against an SDK generated from the Kitchen example API: a client, a call and its typed error,
// the same kind of call on the safe mirror answering a Result, and an event stream released by breaking out of
// its loop. Built and vetted by the docs' tests.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	sdk "example.com/sdk"
)

func newClient() *sdk.Client {
	return sdk.NewClient(sdk.Config{
		BaseURL:     "https://api.example.com",
		BearerToken: os.Getenv("KITCHEN_TOKEN"),
		Timeout:     10 * time.Second,
	})
}

func checkHealth(ctx context.Context, client *sdk.Client) error {
	err := client.GetApiHealth(ctx, nil)
	var failed *sdk.ClientError
	if errors.As(err, &failed) {
		return fmt.Errorf("health check answered %d: %s", failed.StatusCode, failed.Key)
	}
	return err
}

func listing(ctx context.Context, client *sdk.Client) string {
	r, err := client.Safe().GetApi(ctx, nil)
	if err != nil {
		return fmt.Sprintf("no answer: %v", err) // never sent, refused, dropped, timed out or canceled
	}
	var unreadable *sdk.DecodeError
	var failed *sdk.ClientError
	switch {
	case r.Ok():
		return fmt.Sprintf("answered %d: %v", r.Response.StatusCode, r.Data)
	case errors.As(r.Err, &unreadable):
		return fmt.Sprintf("answered %d, unreadable: %v", r.Response.StatusCode, unreadable.Err)
	case errors.As(r.Err, &failed):
		return fmt.Sprintf("answered %d: %s", failed.StatusCode, failed.Key)
	}
	return r.Err.Error()
}

func firstEvents(ctx context.Context, client *sdk.Client, limit int) ([]string, error) {
	var seen []string
	for event, err := range client.GetApiEvents(ctx, nil) {
		if err != nil {
			return seen, err
		}
		seen = append(seen, event.Data)
		if len(seen) == limit {
			break // leaving the loop closes the stream and frees its connection
		}
	}
	return seen, nil
}

func main() {
	if len(os.Args) < 2 {
		return
	}
	ctx := context.Background()
	client := newClient()
	if err := checkHealth(ctx, client); err != nil {
		fmt.Println(err)
		return
	}
	fmt.Println(listing(ctx, client))
	events, err := firstEvents(ctx, client, 2)
	fmt.Println(events, err)
}
